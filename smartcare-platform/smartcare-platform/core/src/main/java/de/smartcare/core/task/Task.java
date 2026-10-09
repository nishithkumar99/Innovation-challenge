package de.smartcare.core.task;

import java.util.HashSet;
import java.util.Set;

/** A transport order (pick up at {@code from}, deliver to {@code to}). Mutable; only touched under the core lock. */
public final class Task {
    public enum Priority { STAT(4), URGENT(2), ROUTINE(1);
        public final double weight;
        Priority(double w) { weight = w; }
    }
    public enum Status { QUEUED, ASSIGNED, TO_PICKUP, IN_TRANSIT, DELIVERED, CANCELLED }

    public final String id;
    public final String source, from, to, requester, requesterName, item, notes, origin;
    public Priority priority;
    public Status status = Status.QUEUED;
    public String robotId;
    public final long createdAt;
    public Long assignedAt, pickedAt, deliveredAt;
    public Double etaSec;
    public long version = 1;
    public final Set<String> excludedRobots = new HashSet<>();

    public Task(String id, String source, String from, String to, Priority priority, String requester, String requesterName,
                String item, String notes, String origin, long createdAt) {
        this.id = id; this.source = source; this.from = from; this.to = to; this.priority = priority;
        this.requester = requester; this.requesterName = requesterName; this.item = item; this.notes = notes;
        this.origin = origin; this.createdAt = createdAt;
    }

    public boolean isOpen() { return status != Status.DELIVERED && status != Status.CANCELLED; }
    public boolean isQueued() { return status == Status.QUEUED; }
    public void touch() { version++; }
    /** End-to-end duration in seconds (only meaningful once delivered). */
    public double seconds() { return deliveredAt == null ? 0 : (deliveredAt - createdAt) / 1000.0; }
}
