package de.smartcare.core.event;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/** JSON shapes consumed by the Angular UI (mirror of src/app/core/models.ts). */
public final class Dto {
    private Dto() {}
    public record Vec(double x, double y) {}
    public record RobotDto(String id, String name, Vec pos, double heading, double speed, double battery, String status,
                           String taskId, List<String> route, List<String> plan, long ts) {}
    public record TaskDto(String id, String source, String from, String to, String priority, String status, String robotId,
                          String requester, String requesterName, String item, String notes, String origin, long createdAt,
                          Long assignedAt, Long pickedAt, Long deliveredAt, Double etaSec, long version) {}
    public record StationDto(String id, String name, String kind, Vec pos, int queue) {}
    public record ZoneOccupancy(String id, String a, String b, double load, boolean blocked) {}
    public record StationQueue(String id, int queue) {}
    public record ZonesPayload(List<ZoneOccupancy> zones, List<StationQueue> stations) {}
    public record Hotspot(String id, String zoneId, Vec center, double radius, int horizonMin, double severity, double confidence) {}
    public record PredictionsPayload(long generatedAt, List<Hotspot> items) {}
    public record CommandRequest(String type, String targetId, Map<String, Object> params, String reason, Long expectedVersion) {}
    public record SuggestedAction(String id, String label, double impactMin, CommandRequest command) {}
    public record InsightDto(String id, String severity, String title, String zoneId, String stationId, double etaMin,
                             double confidence, int affectedTasks, String state, long createdAt, long validUntil,
                             SuggestedAction suggestion, String staffMessage) {}
    public record TaskRequest(String source, String from, String to, String priority, String item, String notes, String origin) {}
    public record ValidationResult(boolean ok, List<String> errors, List<String> warnings) {}
    public record CommandAck(String correlationId, String state, String reason) {}
    public record KpiPoint(long t, double avgSec, double p90Sec, double tph, double saved, @JsonProperty("wait") double waitSec, double toPickup,
                           double transit, double handover) {}
    public record Prev(Double avgTaskSec, Double tasksPerHour) {}
    public record ByStation(String stationId, int count, double avgSec) {}
    public record KpiLive(double avgTaskSec, double p90TaskSec, double tasksPerHour, double staffMinSaved, double slaMet,
                          Prev prev, List<ByStation> byStation, long computedAt, String methodologyVersion, KpiPoint point) {}
    public record SystemStatus(String mode, boolean hold, boolean aiAvailable, List<String> blockedZones, String notice) {}
    public record Snapshot(long seq, long ts, List<RobotDto> robots, List<ZoneOccupancy> zones, List<StationDto> stations,
                           List<Hotspot> predictions, List<TaskDto> tasks, List<InsightDto> insights, KpiLive kpi, SystemStatus system) {}
}
