package de.smartcare.core.routing;

import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.model.MapEdge;
import de.smartcare.core.model.Zone;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.ToDoubleFunction;

/**
 * Time-based shortest path (Dijkstra).
 * Edge cost = learned traversal time (EWMA of real observations) when available, otherwise length / speed,
 * plus a congestion penalty supplied by the caller. Blocked edges and restricted zones are excluded.
 */
public final class Router {
    private final HospitalMap map;
    private final double defaultSpeed;
    private final Map<String, Ewma> learned = new ConcurrentHashMap<>();
    private final Set<String> blockedEdges = ConcurrentHashMap.newKeySet();
    private volatile ToDoubleFunction<String> congestion = e -> 0;
    private volatile boolean avoidChargersAsVia;

    public Router(HospitalMap map, double defaultSpeedMps) {
        this.map = map;
        this.defaultSpeed = defaultSpeedMps;
    }

    /** Charging stations are then used only as start or destination; if that leaves no route they are allowed again. */
    public void setAvoidChargersAsVia(boolean on) { this.avoidChargersAsVia = on; }
    public void setCongestionPenalty(ToDoubleFunction<String> secondsPerEdge) { this.congestion = secondsPerEdge; }
    public void block(String edgeId) { blockedEdges.add(edgeId); }
    public void unblock(String edgeId) { blockedEdges.remove(edgeId); }
    public Set<String> blocked() { return Set.copyOf(blockedEdges); }
    public boolean isBlocked(String edgeId) { return blockedEdges.contains(edgeId); }
    public double speedFor(MapEdge e) { return e.maxSpeed() > 0 ? Math.min(e.maxSpeed(), defaultSpeed) : defaultSpeed; }

    /** Feed an observed traversal time of an edge (seconds) so future estimates adapt to reality. */
    public void observe(String edgeId, double seconds) {
        if (seconds > 0.2) learned.computeIfAbsent(edgeId, k -> new Ewma(0.3)).add(seconds);
    }

    public double edgeTime(MapEdge e) {
        Ewma l = learned.get(e.id());
        double base = e.length() / speedFor(e);
        return l != null && l.count() >= 2 ? l.value(base) : base;
    }

    public Optional<Path> shortest(String from, String to, RouteConstraints c) {
        return search(from, to, c, true);
    }

    /** Free-flow estimate that ignores congestion penalties (used for ETAs and energy needs). */
    public Optional<Path> shortestIgnoringTraffic(String from, String to) {
        return search(from, to, RouteConstraints.NONE, false);
    }

    private Optional<Path> search(String from, String to, RouteConstraints c, boolean useCongestion) {
        if (avoidChargersAsVia) {
            RouteConstraints stricter = c;
            for (var n : map.chargers()) if (!n.id().equals(from) && !n.id().equals(to)) stricter = stricter.withNode(n.id());
            Optional<Path> p = searchOnce(from, to, stricter, useCongestion);
            if (p.isPresent()) return p;
        }
        return searchOnce(from, to, c, useCongestion);
    }

    private Optional<Path> searchOnce(String from, String to, RouteConstraints c, boolean useCongestion) {
        if (map.node(from) == null || map.node(to) == null) return Optional.empty();
        if (from.equals(to)) return Optional.of(new Path(List.of(from), 0, 0));
        Set<String> restrictedNodes = new HashSet<>(), restrictedEdges = new HashSet<>();
        for (Zone z : map.zones()) if (z.restricted()) { restrictedNodes.addAll(z.nodeIds()); restrictedEdges.addAll(z.edgeIds()); }
        restrictedNodes.remove(to);
        restrictedNodes.remove(from);

        Map<String, Double> dist = new HashMap<>();
        Map<String, String> prev = new HashMap<>();
        PriorityQueue<Map.Entry<String, Double>> pq = new PriorityQueue<>(Map.Entry.comparingByValue());
        dist.put(from, 0.0);
        pq.add(Map.entry(from, 0.0));
        while (!pq.isEmpty()) {
            var cur = pq.poll();
            String u = cur.getKey();
            if (cur.getValue() > dist.getOrDefault(u, Double.MAX_VALUE)) continue;
            if (u.equals(to)) break;
            for (MapEdge e : map.edgesOf(u)) {
                String v = e.other(u);
                if (blockedEdges.contains(e.id()) || c.avoidEdges().contains(e.id()) || restrictedEdges.contains(e.id())) continue;
                if ((c.avoidNodes().contains(v) || restrictedNodes.contains(v)) && !v.equals(to)) continue;
                double w = edgeTime(e) + (useCongestion ? congestion.applyAsDouble(e.id()) : 0);
                double nd = dist.get(u) + w;
                if (nd < dist.getOrDefault(v, Double.MAX_VALUE)) {
                    dist.put(v, nd);
                    prev.put(v, u);
                    pq.add(Map.entry(v, nd));
                }
            }
        }
        if (!prev.containsKey(to)) return Optional.empty();
        LinkedList<String> nodes = new LinkedList<>();
        for (String at = to; at != null; at = prev.get(at)) nodes.addFirst(at);
        double time = 0, len = 0;
        for (int i = 0; i + 1 < nodes.size(); i++) {
            MapEdge e = map.edgeBetween(nodes.get(i), nodes.get(i + 1));
            time += edgeTime(e);
            len += e.length();
        }
        return Optional.of(new Path(List.copyOf(nodes), time, len));
    }
}
