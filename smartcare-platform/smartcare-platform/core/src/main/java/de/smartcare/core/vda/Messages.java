package de.smartcare.core.vda;

import java.util.List;

/** VDA 5050 v2.0.0 message records (the subset of fields this system reads or writes; unknown fields are ignored). */
public final class Messages {
    private Messages() {}

    public record NodePosition(double x, double y, Double theta, Double allowedDeviationXY, Double allowedDeviationTheta,
                               String mapId, String mapDescription) {}

    public record ActionParameter(String key, Object value) {}

    public record Action(String actionType, String actionId, String actionDescription, String blockingType,
                         List<ActionParameter> actionParameters) {}

    public record VdaNode(String nodeId, long sequenceId, String nodeDescription, boolean released,
                          NodePosition nodePosition, List<Action> actions) {}

    public record VdaEdge(String edgeId, long sequenceId, String edgeDescription, boolean released, String startNodeId,
                          String endNodeId, Double maxSpeed, Double length, List<Action> actions) {}

    public record Order(long headerId, String timestamp, String version, String manufacturer, String serialNumber,
                        String orderId, long orderUpdateId, String zoneSetId, List<VdaNode> nodes, List<VdaEdge> edges) {}

    public record InstantActions(long headerId, String timestamp, String version, String manufacturer,
                                 String serialNumber, List<Action> actions) {}

    public record NodeState(String nodeId, long sequenceId, String nodeDescription, NodePosition nodePosition, boolean released) {}

    public record EdgeState(String edgeId, long sequenceId, String edgeDescription, boolean released) {}

    public record AgvPosition(boolean positionInitialized, Double localizationScore, Double deviationRange,
                              double x, double y, double theta, String mapId, String mapDescription) {}

    public record Velocity(Double vx, Double vy, Double omega) {}

    public record Load(String loadId, String loadType, String loadPosition) {}

    public record BatteryState(double batteryCharge, Double batteryVoltage, Integer batteryHealth, boolean charging, Double reach) {}

    public record ErrorReference(String referenceKey, String referenceValue) {}

    public record VdaError(String errorType, List<ErrorReference> errorReferences, String errorDescription, String errorLevel) {}

    public record Information(String infoType, String infoDescription, String infoLevel) {}

    public record ActionState(String actionId, String actionType, String actionDescription, String actionStatus, String resultDescription) {}

    public record SafetyState(String eStop, boolean fieldViolation) {}

    public record State(long headerId, String timestamp, String version, String manufacturer, String serialNumber,
                        String orderId, long orderUpdateId, String zoneSetId, String lastNodeId, long lastNodeSequenceId,
                        boolean driving, Boolean paused, Boolean newBaseRequest, Double distanceSinceLastNode,
                        String operatingMode, List<NodeState> nodeStates, List<EdgeState> edgeStates,
                        AgvPosition agvPosition, Velocity velocity, List<Load> loads, BatteryState batteryState,
                        List<VdaError> errors, List<Information> information, List<ActionState> actionStates,
                        SafetyState safetyState) {}

    public record Connection(long headerId, String timestamp, String version, String manufacturer, String serialNumber,
                             String connectionState) {}
}
