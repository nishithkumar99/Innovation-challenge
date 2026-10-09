package de.smartcare.core.vda;

import de.smartcare.core.vda.Messages.*;

import java.util.*;
import java.util.function.LongSupplier;

/**
 * Order mode {@code STEPWISE}: lets the core drive vehicles that do <b>not</b> implement the VDA 5050 base/horizon concept,
 * such as the organizers' Python simulator. That simulator
 * <ul>
 *   <li>ignores the {@code released} flag and drives through every node of an order,</li>
 *   <li>accepts a new order only when the previous one is completely finished (no node or edge left),</li>
 *   <li>accepts an order <i>update</i> only while it stands at the last node, and</li>
 *   <li>removes the action states of a finished order together with the order.</li>
 * </ul>
 * The core itself keeps working with base/horizon: it plans the whole route, releases the part it has reserved and
 * extends the release with order updates. This class sits between the core and the broker and turns that into what such a
 * vehicle understands: it hands the vehicle <i>one order per released stretch</i> (a new, unique order id each time) and
 * issues the next stretch only after the vehicle has finished the previous one and the core has released more. A vehicle
 * therefore never drives further than the core has reserved, which is what makes traffic control and deadlock repair work.
 *
 * <p>Towards the core the vehicle still looks like one VDA 5050 vehicle that executes the core's order: incoming states are
 * rewritten to carry the core's order id, the node sequence the core expects and the nodes that are still ahead.
 * Not thread-safe; callers hold the core lock.
 */
public final class SegmentedOrders {
    /** Sends the order to the vehicle (topic/QoS are the caller's business). */
    public interface Sender { void send(String manufacturer, String serial, Order order); }

    private static final long RESEND_AFTER_MS = 2500;
    private static final long AFTER_CANCEL_MS = 1200;

    private static final class Track {
        final String manufacturer;
        Order desired;                 // the core's latest view: full path, released flags
        String subId;                  // the order currently issued to the vehicle
        Order subOrder;                // for re-sending
        long subEndSeq;                // sequence id of the last node of the issued order
        long fromSeq;                  // sequence id of the node where the issued order starts (where the vehicle stood)
        boolean issuedAny;             // at least one stretch of the desired order has been issued
        long subIssuedMs;
        boolean subAcked;              // the vehicle has reported this order id
        boolean subFinished;           // ... and has nothing left to do for it
        boolean finalIssued;           // the issued order contains the last node of the desired order
        boolean paused;
        long holdUntilMs;              // after cancelOrder the vehicle needs a moment before it accepts an order
        int counter;
        State lastState;
        Track(String m) { this.manufacturer = m; }
    }

    private final Sender sender;
    private final LongSupplier clock;
    private final Map<String, Track> tracks = new HashMap<>();
    private final Map<String, State> seen = new HashMap<>();   // latest state per vehicle, also before its first order
    private int ordersIssued;

    public SegmentedOrders(Sender sender, LongSupplier clock) { this.sender = sender; this.clock = clock; }

    public int ordersIssued() { return ordersIssued; }

    // ───── from the core ─────

    /** A new order, or an update of the current one, as the core's planning produced it. */
    public void submit(String manufacturer, String serial, Order o) {
        Track t = tracks.computeIfAbsent(serial, k -> new Track(manufacturer));
        if (t.lastState == null) t.lastState = seen.get(serial);
        if (o.orderUpdateId() == 0 || t.desired == null || !t.desired.orderId().equals(o.orderId())) {
            if (o.orderUpdateId() != 0) return;                      // update for an order that is no longer current
            t.desired = o;
            t.finalIssued = false;
            t.issuedAny = false;
            t.subEndSeq = t.fromSeq = o.nodes().isEmpty() ? 0 : o.nodes().get(0).sequenceId();   // the vehicle stands at the first node
            t.subAcked = true;                                        // the core submits a new order only when the vehicle is done
            t.subFinished = true;
            t.subOrder = null;
        } else {
            if (o.orderUpdateId() <= t.desired.orderUpdateId() || o.nodes().isEmpty()) return;
            long cut = o.nodes().get(0).sequenceId();
            List<VdaNode> nodes = new ArrayList<>();
            for (VdaNode n : t.desired.nodes()) if (n.sequenceId() < cut) nodes.add(n);
            nodes.addAll(o.nodes());
            List<VdaEdge> edges = new ArrayList<>();
            for (VdaEdge e : t.desired.edges()) if (e.sequenceId() < cut) edges.add(e);
            edges.addAll(o.edges());
            t.desired = new Order(o.headerId(), o.timestamp(), o.version(), o.manufacturer(), o.serialNumber(), o.orderId(),
                    o.orderUpdateId(), o.zoneSetId(), nodes, edges);
        }
        pump(serial, t);
    }

    /**
     * Instant actions of the core. Pause/resume are emulated by holding back further stretches (the simulator has no pause);
     * cancelling drops the current order. Returns true if the action should still be forwarded to the vehicle.
     */
    public boolean instantAction(String serial, Action a) {
        Track t = tracks.get(serial);
        switch (a.actionType()) {
            case Vda.ActionType.START_PAUSE -> { if (t != null) t.paused = true; return false; }
            case Vda.ActionType.STOP_PAUSE -> { if (t != null) { t.paused = false; pump(serial, t); } return false; }
            case Vda.ActionType.CANCEL_ORDER -> {
                if (t != null) {
                    t.desired = null;
                    t.subFinished = true;
                    t.subAcked = true;
                    t.holdUntilMs = clock.getAsLong() + AFTER_CANCEL_MS;
                }
                return true;
            }
            default -> { return true; }
        }
    }

    /** Called from the core's periodic tick: re-sends unacknowledged orders and releases the hold after a cancel. */
    public void tick() {
        for (var e : tracks.entrySet()) pump(e.getKey(), e.getValue());
    }

    // ───── from the vehicle ─────

    /** Processes a state message and returns the state as the core should see it. */
    public State inbound(String serial, State s) {
        seen.put(serial, s);
        Track t = tracks.get(serial);
        if (t == null) return s;
        t.lastState = s;
        if (t.subId != null && t.subId.equals(s.orderId())) {
            t.subAcked = true;
            boolean noNodes = s.nodeStates() == null || s.nodeStates().isEmpty();
            boolean noEdges = s.edgeStates() == null || s.edgeStates().isEmpty();
            if (noNodes && noEdges) t.subFinished = true;
        }
        pump(serial, t);
        return t.desired == null ? s : translate(t, s);
    }

    // ───── internals ─────

    private void pump(String serial, Track t) {
        if (t.desired == null) return;
        long now = clock.getAsLong();
        // an issued order the vehicle has not reported yet: it may have been refused while the previous one was still ending
        if (t.subId != null && !t.subAcked) {
            if (now - t.subIssuedMs >= RESEND_AFTER_MS && t.subOrder != null) {
                t.subIssuedMs = now;
                sender.send(t.manufacturer, serial, t.subOrder);
            }
            return;
        }
        if (t.finalIssued || t.paused || now < t.holdUntilMs) return;
        if (t.lastState == null) return;
        if (t.subId != null && !t.subFinished) return;                 // still driving the previous stretch

        List<VdaNode> nodes = t.desired.nodes();
        int from = indexOfSeq(nodes, t.subEndSeq);
        if (from < 0) return;
        int to = from;
        while (to + 1 < nodes.size() && nodes.get(to + 1).released()) to++;
        boolean last = to == nodes.size() - 1;
        if (to == from) {
            // Nothing new is released. Only a single-node order (vehicle already at its destination) with an action is issued.
            if (last && !t.issuedAny && hasActions(nodes.get(from))) { /* issue it below */ }
            else { if (last) t.finalIssued = true; return; }
        }

        List<VdaNode> sn = new ArrayList<>();
        List<VdaEdge> se = new ArrayList<>();
        for (int i = from; i <= to; i++) {
            VdaNode n = nodes.get(i);
            List<Action> acts = (i == from && to > from) ? List.of() : n.actions();   // the first node's actions belong to the previous stretch
            sn.add(new VdaNode(n.nodeId(), n.sequenceId(), n.nodeDescription(), true, n.nodePosition(), acts));
        }
        for (VdaEdge e : t.desired.edges()) {
            long lo = nodes.get(from).sequenceId(), hi = nodes.get(to).sequenceId();
            if (e.sequenceId() > lo && e.sequenceId() < hi) se.add(new VdaEdge(e.edgeId(), e.sequenceId(), e.edgeDescription(), true,
                    e.startNodeId(), e.endNodeId(), e.maxSpeed(), e.length(), e.actions()));
        }
        String id = t.desired.orderId() + "~" + (++t.counter);
        Order sub = new Order(t.desired.headerId() + t.counter, OrderFactory.now(), t.desired.version(), t.desired.manufacturer(),
                t.desired.serialNumber(), id, 0, t.desired.zoneSetId(), sn, se);
        t.subId = id; t.subOrder = sub; t.subIssuedMs = now;
        t.fromSeq = nodes.get(from).sequenceId();
        t.subEndSeq = nodes.get(to).sequenceId();
        t.issuedAny = true;
        t.subAcked = false; t.subFinished = false; t.finalIssued = last;
        ordersIssued++;
        sender.send(t.manufacturer, serial, sub);
    }

    private static boolean hasActions(VdaNode n) { return n.actions() != null && !n.actions().isEmpty(); }

    private static int indexOfSeq(List<VdaNode> nodes, long seq) {
        for (int i = 0; i < nodes.size(); i++) if (nodes.get(i).sequenceId() == seq) return i;
        return -1;
    }

    /** The vehicle's state, described in terms of the core's order. */
    private State translate(Track t, State s) {
        Order d = t.desired;
        boolean current = t.issuedAny && t.subId != null && t.subId.equals(s.orderId());
        long seq;
        String nodeId;
        if (current) {
            seq = s.lastNodeSequenceId();
            nodeId = s.lastNodeId();
        } else {
            // not reported by the vehicle yet: it still stands where the issued stretch (or the whole order) starts
            int i = indexOfSeq(d.nodes(), t.fromSeq);
            seq = i >= 0 ? d.nodes().get(i).sequenceId() : 0;
            nodeId = i >= 0 ? d.nodes().get(i).nodeId() : s.lastNodeId();
        }
        final long fseq = seq;
        List<NodeState> ns = new ArrayList<>();
        for (VdaNode n : d.nodes()) if (n.sequenceId() > fseq) ns.add(new NodeState(n.nodeId(), n.sequenceId(), n.nodeDescription(), n.nodePosition(), n.released()));
        List<EdgeState> es = new ArrayList<>();
        for (VdaEdge e : d.edges()) if (e.sequenceId() > fseq) es.add(new EdgeState(e.edgeId(), e.sequenceId(), e.edgeDescription(), e.released()));
        List<ActionState> as = current ? s.actionStates() : List.of();
        Boolean paused = t.paused ? Boolean.TRUE : s.paused();
        return new State(s.headerId(), s.timestamp(), s.version(), s.manufacturer(), s.serialNumber(), d.orderId(), d.orderUpdateId(),
                s.zoneSetId(), nodeId, seq, s.driving(), paused, s.newBaseRequest(), s.distanceSinceLastNode(), s.operatingMode(), ns, es,
                s.agvPosition(), s.velocity(), s.loads(), s.batteryState(), s.errors(), s.information(), as, s.safetyState());
    }
}
