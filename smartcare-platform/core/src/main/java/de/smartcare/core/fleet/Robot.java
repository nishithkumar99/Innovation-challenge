package de.smartcare.core.fleet;

import de.smartcare.core.mission.Mission;
import de.smartcare.core.vda.Messages;

/** Digital twin of one AMR, built from its VDA 5050 state/connection messages plus what the core has planned for it. */
public final class Robot {
    public final String serial, manufacturer;
    public boolean online;
    public long lastSeenMs;
    public Messages.State state;               // last raw state message
    public double x, y, heading, speed, battery;
    public boolean charging, driving, paused, hasFatalError, estop;
    public String lastNodeId;
    public long lastNodeSeq;
    public String stateOrderId = "";
    public boolean manual;                      // operator took control – the core does not plan for it
    public Mission mission;
    public String idleSinceNode;
    public long idleSinceMs;
    public String waitingOn;                    // robot id (or "node:X") this robot is blocked by
    public long waitingSinceMs;
    public long tasksRecent;                    // filled by dispatcher for load balancing
    public final java.util.ArrayDeque<Long> completions = new java.util.ArrayDeque<>();
    public long chargeStartedMs;
    public long lastMoveMs;
    public boolean latched;                     // emergency stop issued by an operator, cleared with RESET

    public Robot(String manufacturer, String serial, long now) { this.manufacturer = manufacturer; this.serial = serial; this.lastSeenMs = now; this.idleSinceMs = now; }

    public boolean busy() { return mission != null && !mission.finished(); }
    public boolean available(double criticalBattery) {
        return online && !manual && !paused && !hasFatalError && !estop && !busy() && battery > criticalBattery;
    }
}
