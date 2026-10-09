package de.smartcare.core.traffic;

import de.smartcare.core.model.HospitalMap;

import java.util.*;

/**
 * Space reservations. Edges have capacity 1 (single-lane corridors, no passing or head-on), nodes use their
 * configured capacity. A robot always holds the node it stands on. Reservations for edge+node are granted atomically.
 */
public final class ReservationTable {
    private final HospitalMap map;
    private final Map<String, Set<String>> nodeHolders = new HashMap<>();
    private final Map<String, Set<String>> edgeHolders = new HashMap<>();

    /** Nodes (other than its ends) that lie so close to an edge that a vehicle standing there blocks one driving along the edge. */
    private final Map<String, Set<String>> foulNodes = new HashMap<>();
    /** The reverse: for a node, the edges that run too close to it. */
    private final Map<String, Set<String>> foulEdges = new HashMap<>();

    public ReservationTable(HospitalMap map) { this(map, 0); }

    /**
     * @param clearanceM centre distance below which two vehicles collide (0 = ignore footprints). Edges are straight lines
     *                   between their nodes, as the vehicles drive them, so a node beside a corridor can block it.
     */
    public ReservationTable(HospitalMap map, double clearanceM) {
        this.map = map;
        if (clearanceM <= 0) return;
        for (var e : map.edges()) {
            var a = map.node(e.a()); var b = map.node(e.b());
            for (var n : map.nodes()) {
                if (n.id().equals(a.id()) || n.id().equals(b.id())) continue;
                if (distanceToSegment(n.x(), n.y(), a.x(), a.y(), b.x(), b.y()) < clearanceM - 1e-6) {
                    foulNodes.computeIfAbsent(e.id(), k -> new LinkedHashSet<>()).add(n.id());
                    foulEdges.computeIfAbsent(n.id(), k -> new LinkedHashSet<>()).add(e.id());
                }
            }
        }
    }

    private static double distanceToSegment(double px, double py, double ax, double ay, double bx, double by) {
        double dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        double t = l2 == 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    public Set<String> foulEdgesOf(String nodeId) { return foulEdges.getOrDefault(nodeId, Set.of()); }
    public Set<String> foulNodesOf(String edgeId) { return foulNodes.getOrDefault(edgeId, Set.of()); }

    /** Tries to reserve the edge and its target node. Returns the blocking robots (empty set = granted). */
    public Set<String> tryReserve(String robot, String edgeId, String nodeId) {
        Set<String> blockers = new LinkedHashSet<>();
        for (String h : edgeHolders.getOrDefault(edgeId, Set.of())) if (!h.equals(robot)) blockers.add(h);
        Set<String> nh = nodeHolders.getOrDefault(nodeId, Set.of());
        if (!nh.contains(robot) && nh.size() >= map.node(nodeId).capacity()) {
            for (String h : nh) if (!h.equals(robot)) blockers.add(h);
        }
        for (String fn : foulNodes.getOrDefault(edgeId, Set.of())) for (String h : nodeHolders.getOrDefault(fn, Set.of())) if (!h.equals(robot)) blockers.add(h);
        for (String fe : foulEdges.getOrDefault(nodeId, Set.of())) for (String h : edgeHolders.getOrDefault(fe, Set.of())) if (!h.equals(robot)) blockers.add(h);
        if (!blockers.isEmpty()) return blockers;
        edgeHolders.computeIfAbsent(edgeId, k -> new LinkedHashSet<>()).add(robot);
        nodeHolders.computeIfAbsent(nodeId, k -> new LinkedHashSet<>()).add(robot);
        return Set.of();
    }

    public void holdNode(String robot, String nodeId) { nodeHolders.computeIfAbsent(nodeId, k -> new LinkedHashSet<>()).add(robot); }
    public void releaseNode(String robot, String nodeId) { remove(nodeHolders, nodeId, robot); }
    public void releaseEdge(String robot, String edgeId) { remove(edgeHolders, edgeId, robot); }

    public void releaseAll(String robot) {
        nodeHolders.values().forEach(s -> s.remove(robot));
        edgeHolders.values().forEach(s -> s.remove(robot));
    }

    /** Keeps only the given node (used when a robot is re-planned). */
    public void releaseAllExcept(String robot, String keepNode) {
        releaseAll(robot);
        if (keepNode != null) holdNode(robot, keepNode);
    }

    public Set<String> holdersOfNode(String n) { return nodeHolders.getOrDefault(n, Set.of()); }
    public Set<String> holdersOfEdge(String e) { return edgeHolders.getOrDefault(e, Set.of()); }
    public int nodeLoad(String n) { return holdersOfNode(n).size(); }
    public int edgeLoad(String e) { return holdersOfEdge(e).size(); }

    private static void remove(Map<String, Set<String>> m, String k, String r) {
        Set<String> s = m.get(k);
        if (s != null) { s.remove(r); if (s.isEmpty()) m.remove(k); }
    }
}
