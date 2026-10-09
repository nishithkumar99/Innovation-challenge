package de.smartcare.core.sim;

import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.mqtt.MqttGateway;
import de.smartcare.core.settings.Settings;
import de.smartcare.core.vda.*;
import de.smartcare.core.vda.Messages.*;

import java.util.*;

/**
 * Small VDA 5050 2.0.0 vehicle simulator. It speaks the real protocol over MQTT (order, instantActions, state, connection)
 * so the core can be developed and tested without the organisers' Python simulator. Time is advanced explicitly with
 * {@link #tick(double)} which keeps unit tests deterministic.
 */
public final class AmrSimulator {
    private enum Run { WAITING, RUNNING, FINISHED }

    private final class Bot {
        final String serial;
        double x, y, battery, heading, speed, progress;
        String lastNode; long lastSeq;
        String orderId = ""; long updateId;
        final List<VdaNode> nodes = new ArrayList<>();   // not yet traversed
        final List<VdaEdge> edges = new ArrayList<>();
        final Deque<Action> actionQueue = new ArrayDeque<>();
        final Map<String, String> actionStatus = new LinkedHashMap<>();
        final Map<String, String> actionType = new LinkedHashMap<>();
        Action running; double runLeft;
        boolean paused, charging, driving;
        double drainMul = 1; boolean frozen;
        final List<VdaError> errors = new ArrayList<>();
        double sinceState = 99; long header;
        Bot(String s) { serial = s; }
    }

    private final HospitalMap map;
    private final Settings.Sim cfg;
    private final Settings.Mqtt mq;
    private final MqttGateway mqtt;
    private final Topics topics;
    private final Codec codec = new Codec();
    private final OrderFactory ids;
    private final Map<String, Bot> bots = new LinkedHashMap<>();
    private int actionCounter;

    public AmrSimulator(HospitalMap map, Settings s, MqttGateway mqtt) {
        this.map = map; this.cfg = s.sim; this.mq = s.mqtt; this.mqtt = mqtt;
        this.topics = new Topics(mq.interfaceName, mq.majorVersion);
        this.ids = new OrderFactory(map, mq.mapId);
    }

    /** Creates {@code count} vehicles on the configured start nodes and connects them to MQTT. */
    public void start() {
        String[] starts = cfg.startNodes.split(",");
        for (int i = 0; i < cfg.robots; i++) {
            MapNode n = map.node(starts[i % starts.length].trim());
            if (n == null) throw new IllegalStateException("Unknown sim start node " + starts[i % starts.length]);
            addRobot("AMR-" + (i + 1), n.id(), cfg.startBattery - (i % 3) * 7);
        }
    }

    public Bot addRobot(String serial, String nodeId, double battery) {
        Bot b = new Bot(serial);
        MapNode n = map.node(nodeId);
        b.x = n.x(); b.y = n.y(); b.lastNode = nodeId; b.battery = battery;
        bots.put(serial, b);
        mqtt.subscribe(topics.order(cfg.manufacturer, serial), mq.orderQos, (t, p) -> onOrder(b, p));
        mqtt.subscribe(topics.instantActions(cfg.manufacturer, serial), mq.instantActionQos, (t, p) -> onInstant(b, p));
        publishConnection(b, Vda.ConnectionState.ONLINE);
        publishState(b);
        return b;
    }

    // ───── fault injection (demos and tests) ─────
    public void setDrainMultiplier(String serial, double m) { bots.get(serial).drainMul = m; }
    public void setFrozen(String serial, boolean f) { bots.get(serial).frozen = f; }
    public void setBattery(String serial, double v) { bots.get(serial).battery = v; }
    public void disconnect(String serial) { publishConnection(bots.get(serial), Vda.ConnectionState.CONNECTIONBROKEN); bots.get(serial).frozen = true; }
    public double battery(String serial) { return bots.get(serial).battery; }
    public String node(String serial) { return bots.get(serial).lastNode; }
    public Set<String> serials() { return bots.keySet(); }

    // ───── incoming messages ─────
    private synchronized void onOrder(Bot b, String json) {
        Order o;
        try { o = codec.fromJson(json, Order.class); } catch (RuntimeException e) { error(b, "orderError", "Cannot parse order: " + e.getMessage()); return; }
        if (o.nodes() == null || o.nodes().isEmpty()) { error(b, "orderError", "Order has no nodes"); return; }
        boolean active = !b.nodes.isEmpty() || b.running != null || !b.actionQueue.isEmpty();
        if (!o.orderId().equals(b.orderId)) {
            if (active) { error(b, "orderUpdateError", "New order received while previous order is active"); return; }
            VdaNode first = o.nodes().get(0);
            if (!first.nodeId().equals(b.lastNode)) { error(b, "noRouteError", "Order starts at " + first.nodeId() + " but vehicle is at " + b.lastNode); return; }
            b.orderId = o.orderId(); b.updateId = o.orderUpdateId();
            b.nodes.clear(); b.edges.clear(); b.actionQueue.clear(); b.actionStatus.keySet().removeIf(k -> k.startsWith("n:")); b.errors.clear();
            b.lastSeq = first.sequenceId();
            append(b, o, first.sequenceId(), true);
        } else {
            if (o.orderUpdateId() <= b.updateId) { error(b, "orderUpdateError", "Stale orderUpdateId " + o.orderUpdateId()); return; }
            long baseSeq = o.nodes().get(0).sequenceId();
            if (baseSeq < b.lastSeq) { error(b, "orderUpdateError", "Update starts before last traversed node"); return; }
            b.updateId = o.orderUpdateId();
            b.nodes.removeIf(n -> n.sequenceId() >= baseSeq);
            b.edges.removeIf(e -> e.sequenceId() >= baseSeq);
            append(b, o, baseSeq, false);
        }
        publishState(b);
    }

    private void append(Bot b, Order o, long fromSeq, boolean isNew) {
        for (VdaNode n : o.nodes()) {
            if (n.sequenceId() < fromSeq || (n.sequenceId() == b.lastSeq && !isNew) || (isNew && n.sequenceId() == fromSeq)) {
                if (isNew && n.sequenceId() == fromSeq) queueActions(b, n);
                continue;
            }
            b.nodes.add(n);
            for (Action a : safe(n.actions())) { b.actionStatus.put("n:" + a.actionId(), Vda.ActionStatus.WAITING); b.actionType.put("n:" + a.actionId(), a.actionType()); }
        }
        for (VdaEdge e : o.edges()) if (e.sequenceId() >= fromSeq) b.edges.add(e);
    }

    private void queueActions(Bot b, VdaNode n) {
        for (Action a : safe(n.actions())) { b.actionQueue.add(a); b.actionStatus.put("n:" + a.actionId(), Vda.ActionStatus.WAITING); b.actionType.put("n:" + a.actionId(), a.actionType()); }
    }

    private synchronized void onInstant(Bot b, String json) {
        InstantActions ia = codec.fromJson(json, InstantActions.class);
        for (Action a : safe(ia.actions())) {
            String id = "i:" + a.actionId();
            b.actionType.put(id, a.actionType());
            switch (a.actionType()) {
                case Vda.ActionType.START_PAUSE -> { b.paused = true; b.actionStatus.put(id, Vda.ActionStatus.FINISHED); }
                case Vda.ActionType.STOP_PAUSE -> { b.paused = false; b.actionStatus.put(id, Vda.ActionStatus.FINISHED); }
                case Vda.ActionType.CANCEL_ORDER -> {
                    if (b.nodes.isEmpty() && b.running == null) { b.actionStatus.put(id, Vda.ActionStatus.FAILED); error(b, "noOrderToCancel", "No active order"); }
                    else {
                        b.nodes.clear(); b.edges.clear(); b.actionQueue.clear(); b.running = null; b.driving = false; b.speed = 0; b.progress = 0;
                        b.x = map.node(b.lastNode).x(); b.y = map.node(b.lastNode).y();
                        b.actionStatus.put(id, Vda.ActionStatus.FINISHED);
                    }
                }
                case Vda.ActionType.START_CHARGING -> { b.charging = true; b.actionStatus.put(id, Vda.ActionStatus.FINISHED); }
                case Vda.ActionType.STOP_CHARGING -> { b.charging = false; b.actionStatus.put(id, Vda.ActionStatus.FINISHED); }
                case Vda.ActionType.STATE_REQUEST -> b.actionStatus.put(id, Vda.ActionStatus.FINISHED);
                default -> { b.actionStatus.put(id, Vda.ActionStatus.FAILED); error(b, "unsupportedAction", a.actionType()); }
            }
        }
        publishState(b);
    }

    // ───── time ─────
    public synchronized void tick(double dt) {
        for (Bot b : bots.values()) {
            step(b, dt);
            b.sinceState += dt;
            if (b.sinceState >= 1.0 / Math.max(0.1, cfg.stateHz)) publishState(b);
        }
    }

    private void step(Bot b, double dt) {
        if (b.frozen) return;
        // battery
        if (b.charging) {
            b.battery = Math.min(100, b.battery + cfg.chargePctPerSec * dt);
        } else if (!b.driving) {
            b.battery = Math.max(0, b.battery - cfg.idleDrainPctPerMin / 60.0 * dt * b.drainMul);
        }
        if (b.paused) { b.driving = false; b.speed = 0; return; }

        // run a node action
        if (b.running != null) {
            b.runLeft -= dt;
            if (b.runLeft <= 0) {
                String key = "n:" + b.running.actionId();
                b.actionStatus.put(key, Vda.ActionStatus.FINISHED);
                if (Vda.ActionType.START_CHARGING.equals(b.running.actionType())) b.charging = true;
                b.running = null;
                b.sinceState = 99;
            }
            return;
        }
        if (!b.actionQueue.isEmpty()) {
            b.running = b.actionQueue.poll();
            b.runLeft = Vda.ActionType.START_CHARGING.equals(b.running.actionType()) ? 0.1 : cfg.actionSeconds;
            b.actionStatus.put("n:" + b.running.actionId(), Vda.ActionStatus.RUNNING);
            b.driving = false; b.speed = 0;
            b.sinceState = 99;
            return;
        }
        // drive along the next released edge
        if (b.nodes.isEmpty() || b.edges.isEmpty()) { b.driving = false; b.speed = 0; return; }
        VdaEdge e = b.edges.get(0);
        VdaNode target = b.nodes.get(0);
        if (!e.released() || !target.released() || b.battery <= 0) { b.driving = false; b.speed = 0; return; }
        if (b.charging) b.charging = false;   // driving away implicitly ends charging
        MapNode from = map.node(b.lastNode), to = map.node(target.nodeId());
        double len = Math.max(0.01, e.length() != null ? e.length() : from.pos().dist(to.pos()));
        double v = Math.min(cfg.speedMps, e.maxSpeed() != null && e.maxSpeed() > 0 ? e.maxSpeed() : cfg.speedMps);
        double dist = Math.min(len - b.progress, v * dt);
        b.progress += dist;
        b.driving = true; b.speed = v;
        b.battery = Math.max(0, b.battery - cfg.drainPctPerMeter * dist * b.drainMul);
        double f = b.progress / len;
        b.x = from.x() + (to.x() - from.x()) * f;
        b.y = from.y() + (to.y() - from.y()) * f;
        b.heading = Math.atan2(to.y() - from.y(), to.x() - from.x());
        if (b.progress >= len - 1e-9) {
            b.lastNode = target.nodeId(); b.lastSeq = target.sequenceId(); b.progress = 0;
            b.nodes.remove(0); b.edges.remove(0);
            b.x = to.x(); b.y = to.y(); b.driving = false; b.speed = 0;
            queueActions(b, target);
            b.sinceState = 99;
        }
    }

    // ───── outgoing messages ─────
    private void publishConnection(Bot b, String state) {
        Connection c = new Connection(ids.nextHeader(b.serial, "connection"), OrderFactory.now(), Vda.VERSION, cfg.manufacturer, b.serial, state);
        mqtt.publish(topics.connection(cfg.manufacturer, b.serial), codec.toJson(c), mq.connectionQos, true);
    }

    private void publishState(Bot b) {
        b.sinceState = 0;
        List<NodeState> ns = new ArrayList<>();
        for (VdaNode n : b.nodes) ns.add(new NodeState(n.nodeId(), n.sequenceId(), n.nodeDescription(), n.nodePosition(), n.released()));
        List<EdgeState> es = new ArrayList<>();
        for (VdaEdge e : b.edges) es.add(new EdgeState(e.edgeId(), e.sequenceId(), e.edgeDescription(), e.released()));
        List<ActionState> as = new ArrayList<>();
        b.actionStatus.forEach((k, v) -> as.add(new ActionState(k.substring(2), b.actionType.get(k), null, v, null)));
        boolean newBase = !b.nodes.isEmpty() && b.nodes.stream().noneMatch(VdaNode::released) && !b.driving;
        State s = new State(b.header++, OrderFactory.now(), Vda.VERSION, cfg.manufacturer, b.serial, b.orderId, b.updateId, null,
                b.lastNode, b.lastSeq, b.driving, b.paused, newBase, null, "AUTOMATIC", ns, es,
                new AgvPosition(true, 1.0, null, b.x, b.y, b.heading, mq.mapId, null),
                new Velocity(b.speed, 0.0, 0.0), List.of(),
                new BatteryState(Math.round(b.battery * 10) / 10.0, null, null, b.charging, null),
                List.copyOf(b.errors), List.of(), as, new SafetyState("NONE", false));
        mqtt.publish(topics.state(cfg.manufacturer, b.serial), codec.toJson(s), mq.stateQos, false);
    }

    private void error(Bot b, String type, String desc) {
        b.errors.add(new VdaError(type, List.of(), desc, Vda.ErrorLevel.WARNING));
        if (b.errors.size() > 10) b.errors.remove(0);
        publishState(b);
    }

    private static <T> List<T> safe(List<T> l) { return l == null ? List.of() : l; }
}
