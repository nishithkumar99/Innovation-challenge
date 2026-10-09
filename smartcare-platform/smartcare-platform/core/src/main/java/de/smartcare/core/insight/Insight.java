package de.smartcare.core.insight;

import de.smartcare.core.event.Dto;

/** An AI/analytics finding shown to operators. Lifecycle: NEW → ACKNOWLEDGED → ACTION_APPLIED | DISMISSED | RESOLVED | EXPIRED. */
public final class Insight {
    public final String id, key, category;
    public String severity, title, zoneId, stationId, state = "NEW", staffMessage;
    public double etaMin, confidence;
    public int affectedTasks;
    public long createdAt, validUntil, updatedAt;
    public Dto.SuggestedAction suggestion;
    public boolean narrated;

    public Insight(String id, String key, String category) { this.id = id; this.key = key; this.category = category; }

    public boolean active() { return switch (state) { case "NEW", "ACKNOWLEDGED", "ACTION_PROPOSED" -> true; default -> false; }; }

    public Dto.InsightDto dto() {
        return new Dto.InsightDto(id, severity, title, zoneId, stationId, etaMin, confidence, affectedTasks, state, createdAt, validUntil, suggestion, staffMessage);
    }
}
