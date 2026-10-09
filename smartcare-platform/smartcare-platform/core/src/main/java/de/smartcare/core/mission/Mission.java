package de.smartcare.core.mission;

import java.util.List;

/** What a robot is currently working on: one or two legs, each of which is sent to the vehicle as one VDA 5050 order. */
public final class Mission {
    public enum Type { TASK, CHARGE, GOTO }
    public enum Role { PICKUP, DROP, CHARGE, GOTO }

    /** A leg ends at {@code path.get(last)} where {@code role} decides the node action (pick / drop / startCharging / none). */
    public static final class Leg {
        public List<String> path;
        public final Role role;
        // runtime state of the leg's order
        public String orderId;
        public long updateId = -1;
        public int releasedIdx = -1;   // highest node index that has been released to the vehicle
        public int reachedIdx = -1;    // highest node index reported as last node by the vehicle
        public boolean sent, actionDone;
        public long startedAtMs, lastProgressMs;
        public double startBattery;
        public String actionId;
        public Leg(List<String> path, Role role) { this.path = path; this.role = role; }
        public String last() { return path.get(path.size() - 1); }
    }

    public final Type type;
    public final String taskId;
    public final List<Leg> legs;
    public int legIdx;

    public Mission(Type type, String taskId, List<Leg> legs) { this.type = type; this.taskId = taskId; this.legs = legs; }
    public Leg current() { return legIdx < legs.size() ? legs.get(legIdx) : null; }
    public boolean finished() { return legIdx >= legs.size(); }
}
