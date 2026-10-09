package de.smartcare.core.api;

import de.smartcare.core.event.Dto;
import de.smartcare.core.event.Envelope;

import java.util.*;

/**
 * Per-user data scoping for the realtime stream and the snapshot. Operators see everything; staff only their own
 * requests and the robot working on them. Topics a user may not see keep their sequence number but carry no payload,
 * so the client's gap detection keeps working.
 */
public final class Scope {
    private final User user;
    private final Set<String> myRobots = new HashSet<>();
    private final Set<String> myTasks = new HashSet<>();

    public Scope(User user) { this.user = user; }

    public User user() { return user; }

    private boolean mine(Dto.TaskDto t) {
        if (user.can("task:read:all")) return true;
        if (t.requester().equals(user.id())) return true;
        return user.can("task:read:dept") && user.department() != null && (user.department().equals(t.to()) || user.department().equals(t.from()));
    }

    @SuppressWarnings("unchecked")
    public Envelope filter(Envelope e) {
        if (user.isOps()) return e;
        switch (e.topic()) {
            case "tasks.events" -> {
                List<Dto.TaskDto> l = ((List<Dto.TaskDto>) e.payload()).stream().filter(this::mine).toList();
                for (Dto.TaskDto t : l) { myTasks.add(t.id()); if (t.robotId() != null && t.status().matches("ASSIGNED|TO_PICKUP|IN_TRANSIT")) myRobots.add(t.robotId()); }
                return new Envelope(e.topic(), e.seq(), e.ts(), l);
            }
            case "fleet.robots" -> {
                List<Dto.RobotDto> l = ((List<Dto.RobotDto>) e.payload()).stream().filter(r -> myRobots.contains(r.id()) && r.taskId() != null && myTasks.contains(r.taskId())).toList();
                return new Envelope(e.topic(), e.seq(), e.ts(), l);
            }
            case "fleet.zones" -> { return new Envelope(e.topic(), e.seq(), e.ts(), new Dto.ZonesPayload(List.of(), ((Dto.ZonesPayload) e.payload()).stations())); }
            case "ai.insights", "system.status" -> { return e; }
            default -> { return new Envelope(e.topic(), e.seq(), e.ts(), null); }
        }
    }

    public Dto.Snapshot filter(Dto.Snapshot s) {
        if (user.isOps()) return s;
        List<Dto.TaskDto> tasks = s.tasks().stream().filter(this::mine).toList();
        myTasks.clear(); myRobots.clear();
        for (Dto.TaskDto t : tasks) { myTasks.add(t.id()); if (t.robotId() != null && t.status().matches("ASSIGNED|TO_PICKUP|IN_TRANSIT")) myRobots.add(t.robotId()); }
        List<Dto.RobotDto> robots = s.robots().stream().filter(r -> myRobots.contains(r.id()) && r.taskId() != null && myTasks.contains(r.taskId())).toList();
        return new Dto.Snapshot(s.seq(), s.ts(), robots, List.of(), s.stations(), List.of(), tasks, s.insights(), s.kpi(), s.system());
    }
}
