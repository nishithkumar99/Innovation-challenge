package de.smartcare.core.engine;

import de.smartcare.core.event.Dto;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.task.Task;
import de.smartcare.core.vda.OrderFactory;
import de.smartcare.core.vda.Vda;

import java.util.*;

/**
 * Operator commands. Each command is acknowledged on the realtime stream: ACCEPTED → DONE or REJECTED.
 * The REST call itself only returns the correlation id (the UI waits for the terminal ack).
 */
final class CommandService {
    private final CoreEngine core;
    private final Context c;
    private final MissionService missions;
    private final EnergyManager energy;

    CommandService(CoreEngine core) { this.core = core; this.c = core.c; this.missions = core.missions; this.energy = core.energy; }

    void execute(Dto.CommandRequest cmd, String correlationId, String actor) {
        ack(correlationId, "ACCEPTED", null);
        try {
            String note = run(cmd, actor);
            ack(correlationId, "DONE", note);
        } catch (IllegalArgumentException | IllegalStateException e) {
            ack(correlationId, "REJECTED", e.getMessage());
        }
    }

    private void ack(String id, String state, String reason) { c.bus.publish("commands.acks", new Dto.CommandAck(id, state, reason)); }

    private String run(Dto.CommandRequest cmd, String actor) {
        Map<String, Object> p = cmd.params() == null ? Map.of() : cmd.params();
        switch (cmd.type()) {
            case "PAUSE" -> { Robot r = robot(cmd); c.sendInstant(r, OrderFactory.simple(Vda.ActionType.START_PAUSE, id("pause"))); }
            case "RESUME" -> { Robot r = robot(cmd); c.sendInstant(r, OrderFactory.simple(Vda.ActionType.STOP_PAUSE, id("resume"))); }
            case "ESTOP" -> {
                Robot r = robot(cmd);
                r.latched = true;
                c.sendInstant(r, OrderFactory.simple(Vda.ActionType.START_PAUSE, id("estop")));
                if (r.mission != null) { cancelMission(r, true); }
            }
            case "RESET" -> {
                Robot r = robot(cmd);
                r.latched = false; r.manual = false;
                c.sendInstant(r, OrderFactory.simple(Vda.ActionType.STOP_PAUSE, id("reset")));
            }
            case "CHARGE" -> {
                Robot r = robot(cmd);
                if (r.busy()) throw new IllegalStateException(r.serial + " is busy; reassign its task first");
                if (!energy.startCharging(r)) throw new IllegalStateException("No free charger");
            }
            case "GOTO" -> {
                Robot r = robot(cmd);
                String node = String.valueOf(p.get("nodeId"));
                if (c.map.node(node) == null) throw new IllegalArgumentException("Unknown node " + node);
                if (r.busy()) throw new IllegalStateException(r.serial + " is busy");
                var m = missions.planSingle(r, node, Mission.Type.GOTO, Mission.Role.GOTO).orElseThrow(() -> new IllegalStateException("No route to " + node));
                missions.start(r, m);
            }
            case "TAKE_MANUAL" -> { Robot r = robot(cmd); r.manual = true; if (r.mission != null) cancelMission(r, true); }
            case "RELEASE_MANUAL" -> { Robot r = robot(cmd); r.manual = false; r.idleSinceMs = c.now(); }
            case "REASSIGN" -> {
                Task t = task(cmd);
                if (!t.isOpen()) throw new IllegalStateException(t.id + " is already " + t.status);
                if (t.status == Task.Status.IN_TRANSIT) throw new IllegalStateException("Cargo is on board; cannot reassign");
                String wanted = p.get("robotId") == null ? null : String.valueOf(p.get("robotId"));
                if (t.robotId != null) {
                    Robot old = c.fleet.get(t.robotId);
                    if (old != null && old.mission != null) cancelMission(old, false);
                    t.excludedRobots.add(t.robotId);
                }
                t.status = Task.Status.QUEUED; t.robotId = null; t.assignedAt = null; t.touch();
                c.bus.publish("tasks.events", List.of(TaskMapper.dto(t)));
                if (wanted != null) {
                    Robot r = c.fleet.get(wanted);
                    if (r == null || !r.available(c.cfg.energy.criticalPct)) throw new IllegalStateException(wanted + " is not available");
                    t.excludedRobots.clear();
                    t.excludedRobots.addAll(c.fleet.all().stream().map(x -> x.serial).filter(s -> !s.equals(wanted)).toList());
                }
            }
            case "CANCEL_TASK" -> {
                Task t = task(cmd);
                if (!t.isOpen()) throw new IllegalStateException(t.id + " is already " + t.status);
                if (t.status == Task.Status.IN_TRANSIT) throw new IllegalStateException("Cargo is on board; cannot cancel");
                if (t.robotId != null) { Robot r = c.fleet.get(t.robotId); if (r != null && r.mission != null) cancelMission(r, false); }
                t.status = Task.Status.CANCELLED; t.robotId = null; t.touch();
                c.bus.publish("tasks.events", List.of(TaskMapper.dto(t)));
            }
            case "SET_PRIORITY" -> {
                Task t = task(cmd);
                t.priority = Task.Priority.valueOf(String.valueOf(p.get("priority")));
                t.touch();
                c.bus.publish("tasks.events", List.of(TaskMapper.dto(t)));
            }
            case "FLEET_HOLD" -> { c.hold = true; publishSystem(); }
            case "FLEET_RESUME" -> { c.hold = false; publishSystem(); }
            case "SET_MODE" -> {
                String m = String.valueOf(p.get("mode"));
                if (!m.equals("AUTO") && !m.equals("SEMI_AUTO")) throw new IllegalArgumentException("Unknown mode " + m);
                c.mode = m; publishSystem();
            }
            case "BLOCK_ZONE" -> {
                if (c.map.edge(cmd.targetId()) == null) throw new IllegalArgumentException("Unknown edge " + cmd.targetId());
                c.router.block(cmd.targetId()); publishSystem();
            }
            case "UNBLOCK_ZONE" -> { c.router.unblock(cmd.targetId()); publishSystem(); }
            default -> throw new IllegalArgumentException("Unknown command " + cmd.type());
        }
        return null;
    }

    /** Cancels the vehicle's order and (optionally) puts its task back in the queue. */
    void cancelMission(Robot r, boolean requeue) {
        Task t = missions.taskOf(r);
        c.sendInstant(r, OrderFactory.simple(Vda.ActionType.CANCEL_ORDER, id("cancel")));
        if (t != null && t.isOpen() && requeue) {
            t.excludedRobots.add(r.serial);
            t.status = Task.Status.QUEUED; t.robotId = null; t.assignedAt = null; t.pickedAt = null; t.touch();
            c.bus.publish("tasks.events", List.of(TaskMapper.dto(t)));
        }
        c.reservations.releaseAllExcept(r.serial, c.occupiedNode(r));
        r.mission = null;
        r.idleSinceMs = c.now();
    }

    void publishSystem() { c.bus.publish("system.status", core.systemStatus()); }

    private Robot robot(Dto.CommandRequest cmd) {
        Robot r = c.fleet.get(cmd.targetId());
        if (r == null) throw new IllegalArgumentException("Unknown robot " + cmd.targetId());
        return r;
    }

    private Task task(Dto.CommandRequest cmd) {
        Task t = c.tasks.get(cmd.targetId());
        if (t == null) throw new IllegalArgumentException("Unknown task " + cmd.targetId());
        if (cmd.expectedVersion() != null && cmd.expectedVersion() != t.version) throw new IllegalStateException("Task changed meanwhile (version " + t.version + "); refresh and retry");
        return t;
    }

    private int n;
    private String id(String p) { return p + "-" + c.now() + "-" + (++n); }
}
