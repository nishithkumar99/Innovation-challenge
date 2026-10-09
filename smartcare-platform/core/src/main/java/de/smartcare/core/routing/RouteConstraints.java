package de.smartcare.core.routing;

import java.util.Set;

/** Resources a route must not use. Start and goal nodes are always allowed. */
public record RouteConstraints(Set<String> avoidEdges, Set<String> avoidNodes) {
    public static final RouteConstraints NONE = new RouteConstraints(Set.of(), Set.of());
    public RouteConstraints withEdge(String edgeId) {
        var e = new java.util.HashSet<>(avoidEdges);
        e.add(edgeId);
        return new RouteConstraints(e, avoidNodes);
    }
    public RouteConstraints withNode(String nodeId) {
        var n = new java.util.HashSet<>(avoidNodes);
        n.add(nodeId);
        return new RouteConstraints(avoidEdges, n);
    }
}
