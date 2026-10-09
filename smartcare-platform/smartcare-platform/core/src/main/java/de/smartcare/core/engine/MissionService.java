package de.smartcare.core.engine;

import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.mission.Mission.Leg;
import de.smartcare.core.mission.Mission.Role;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.routing.Path;
import de.smartcare.core.routing.RouteConstraints;
import de.smartcare.core.task.Task;
import de.smartcare.core.vda.Messages.*;
import de.smartcare.core.vda.OrderFactory;
import de.smartcare.core.vda.Vda;

import java.util.*;

/** Turns missions into VDA 5050 orders and tracks their execution from the vehicle's state messages. */
final class MissionService {
    private final Context c;
    private final TaskEvents events;
    private int orderCounter;

    interface TaskEvents { void taskChanged(Task t); void legDone(Robot r, Leg leg); void missionFailed(Robot r, String reason); }

    MissionService(Context c, TaskEvents events) { this.c = c; this.events = events; }

    /** Plans the legs of a transport task for this robot. Empty if no route exists. */
    Optional<Mission> planTask(Robot r, Task t) {
        Optional<Path> a = route(r, r.lastNodeId, t.from);
        Optional<Path> b = route(r, t.from, t.to);
        if (a.isEmpty() || b.isEmpty()) return Optional.empty();
        return Optional.of(new Mission(Mission.Type.TASK, t.id, List.of(new Leg(a.get().nodes(), Role.PICKUP), new Leg(b.get().nodes(), Role.DROP))));
    }

    Optional<Mission> planSingle(Robot r, String target, Mission.Type type, Role role) {
        return route(r, r.lastNodeId, target)
                .map(p -> new Mission(type, null, List.of(new Leg(p.nodes(), role))));
    }

    /** Shortest route that does not lead through nodes on which other vehicles stand; if there is none, the plain shortest route. */
    Optional<Path> route(Robot r, String from, String to) {
        RouteConstraints rc = RouteConstraints.NONE, nodesOnly = RouteConstraints.NONE;
        for (String n : c.standingNodes(r)) {
            rc = rc.withNode(n); nodesOnly = nodesOnly.withNode(n);
            for (String e : c.reservations.foulEdgesOf(n)) rc = rc.withEdge(e);      // a vehicle beside a corridor blocks it
        }
        Optional<Path> p = c.router.shortest(from, to, rc);
        if (p.isEmpty()) p = c.router.shortest(from, to, nodesOnly);
        return p.isPresent() ? p : c.router.shortest(from, to, RouteConstraints.NONE);
    }

    /** Drops the vehicle's current mission (optional trips such as parking) and leaves it standing where it is. */
    void abandon(Robot r) {
        c.sendInstant(r, OrderFactory.simple(Vda.ActionType.CANCEL_ORDER, "abandon-" + c.now() + "-" + (++orderCounter)));
        c.reservations.releaseAllExcept(r.serial, c.occupiedNode(r));
        r.mission = null;
        r.idleSinceMs = c.now();
    }

    void start(Robot r, Mission m) {
        r.mission = m;
        if (c.occupiedNode(r) != null) c.reservations.holdNode(r.serial, r.lastNodeId);
        if (r.charging) c.sendInstant(r, OrderFactory.simple(Vda.ActionType.STOP_CHARGING, "stopc-" + (++orderCounter)));
        sendLeg(r, m.current(), true);
    }

    private void sendLeg(Robot r, Leg leg, boolean first) {
        leg.orderId = "o-" + r.serial + "-" + (++orderCounter);
        leg.updateId = 0;
        leg.releasedIdx = 0;
        leg.reachedIdx = 0;
        leg.sent = true;
        leg.startedAtMs = c.now();
        leg.lastProgressMs = c.now();
        leg.startBattery = r.battery;
        leg.actionDone = false;
        leg.actionId = null;
        Map<Integer, List<Action>> actions = new HashMap<>();
        int last = leg.path.size() - 1;
        switch (leg.role) {
            case PICKUP -> leg.actionId = "pick-" + leg.orderId;
            case DROP -> leg.actionId = "drop-" + leg.orderId;
            case CHARGE -> leg.actionId = "chg-" + leg.orderId;
            default -> {}
        }
        if (leg.actionId != null && actionType(leg.role).isBlank()) leg.actionId = null;   // configured: vehicle needs no action here
        if (leg.actionId != null) {
            String type = actionType(leg.role);
            Mission mm = r.mission;
            Map<String, Object> params = new HashMap<>();
            if (mm != null && mm.taskId != null) params.put("taskId", mm.taskId);
            actions.put(last, List.of(OrderFactory.action(type, leg.actionId, Vda.Blocking.HARD, params)));
        }
        c.sendOrder(r, c.orders.order(r.manufacturer, r.serial, leg.orderId, 0, leg.path, 0, 0, actions));
        Task t = taskOf(r);
        if (t != null && leg.role == Role.PICKUP && t.status == Task.Status.ASSIGNED) { t.status = Task.Status.TO_PICKUP; t.touch(); events.taskChanged(t); }
    }

    /** Re-sends the (changed) remainder of the current leg as an order update beginning at the current base end. */
    void sendUpdate(Robot r, Leg leg, int oldReleasedIdx) {
        leg.updateId++;
        Map<Integer, List<Action>> actions = new HashMap<>();
        int last = leg.path.size() - 1;
        if (leg.actionId != null) {
            String type = actionType(leg.role);
            Map<String, Object> params = new HashMap<>();
            if (r.mission != null && r.mission.taskId != null) params.put("taskId", r.mission.taskId);
            actions.put(last, List.of(OrderFactory.action(type, leg.actionId, Vda.Blocking.HARD, params)));
        }
        c.sendOrder(r, c.orders.order(r.manufacturer, r.serial, leg.orderId, leg.updateId, leg.path, leg.releasedIdx, oldReleasedIdx, actions));
    }

    /** Configured VDA action type for a leg's final node; blank means "send no action". */
    String actionType(Role role) {
        return switch (role) { case PICKUP -> c.cfg.mqtt.pickAction; case DROP -> c.cfg.mqtt.dropAction; default -> c.cfg.mqtt.chargeAction; };
    }

    Task taskOf(Robot r) { return r.mission != null && r.mission.taskId != null ? c.tasks.get(r.mission.taskId) : null; }

    /** Called after each state message of a robot that has a mission. */
    void onState(Robot r) {
        Mission m = r.mission;
        if (m == null || m.finished()) return;
        Leg leg = m.current();
        if (!leg.sent) return;
        State s = r.state;
        if (!leg.orderId.equals(s.orderId())) {
            if (c.now() - leg.startedAtMs > c.cfg.core.orderAckTimeoutS * 1000L) {
                events.missionFailed(r, "Vehicle did not acknowledge order " + leg.orderId + (s.errors() != null && !s.errors().isEmpty() ? ": " + s.errors().get(s.errors().size() - 1).errorDescription() : ""));
            }
            return;
        }
        int idx = (int) (s.lastNodeSequenceId() / 2);
        if (idx > leg.reachedIdx) { leg.reachedIdx = Math.min(idx, leg.path.size() - 1); leg.lastProgressMs = c.now(); }
        if (s.errors() != null) for (VdaError e : s.errors()) if (Vda.ErrorLevel.FATAL.equals(e.errorLevel())) { events.missionFailed(r, "Vehicle reports fatal error " + e.errorType()); return; }

        boolean atEnd = leg.reachedIdx >= leg.path.size() - 1;
        if (!atEnd) return;
        if (leg.actionId != null) {
            ActionState st = s.actionStates() == null ? null : s.actionStates().stream().filter(a -> leg.actionId.equals(a.actionId())).findFirst().orElse(null);
            if (st == null) {
                // Some vehicles (the organizers' simulator) drop the action state together with the finished order,
                // so a missing state counts as done once the vehicle has no node or edge left.
                boolean orderDone = (s.nodeStates() == null || s.nodeStates().isEmpty()) && (s.edgeStates() == null || s.edgeStates().isEmpty());
                if (!orderDone) return;
            } else {
                if (Vda.ActionStatus.FAILED.equals(st.actionStatus())) { events.missionFailed(r, "Action " + st.actionType() + " failed"); return; }
                if (!Vda.ActionStatus.FINISHED.equals(st.actionStatus())) return;
            }
        }
        complete(r, leg);
    }

    private void complete(Robot r, Leg leg) {
        Mission m = r.mission;
        leg.actionDone = true;
        events.legDone(r, leg);
        Task t = taskOf(r);
        long now = c.now();
        if (leg.role == Role.PICKUP && t != null) { t.status = Task.Status.IN_TRANSIT; t.pickedAt = now; t.touch(); events.taskChanged(t); }
        if (leg.role == Role.DROP && t != null) {
            t.status = Task.Status.DELIVERED; t.deliveredAt = now; t.etaSec = 0.0; t.touch(); events.taskChanged(t);
            r.completions.add(now);
        }
        m.legIdx++;
        if (m.finished()) {
            c.reservations.releaseAllExcept(r.serial, c.occupiedNode(r));
            r.mission = null;
            r.idleSinceMs = now;
            return;
        }
        // next leg starts where the previous ended
        Leg next = m.current();
        if (!next.path.get(0).equals(r.lastNodeId)) {
            Optional<Path> p = route(r, r.lastNodeId, next.last());
            if (p.isEmpty()) { events.missionFailed(r, "No route to " + next.last()); return; }
            next.path = p.get().nodes();
        } else {
            Optional<Path> p = route(r, next.path.get(0), next.last());      // the world has changed since the task was planned
            if (p.isPresent()) next.path = p.get().nodes();
        }
        c.reservations.releaseAllExcept(r.serial, c.occupiedNode(r));
        sendLeg(r, next, false);
    }

    /** Remaining free-flow seconds of the mission, for ETAs. */
    double remainingSeconds(Robot r) {
        Mission m = r.mission;
        if (m == null || m.finished()) return 0;
        double sum = 0;
        for (int i = m.legIdx; i < m.legs.size(); i++) {
            Leg l = m.legs.get(i);
            int from = i == m.legIdx ? Math.max(0, l.reachedIdx) : 0;
            for (int k = from; k + 1 < l.path.size(); k++) sum += c.router.edgeTime(c.map.edgeBetween(l.path.get(k), l.path.get(k + 1)));
            if (l.actionId != null) sum += c.cfg.sim.actionSeconds;
        }
        return sum;
    }

    MapNode node(String id) { return c.map.node(id); }
}
