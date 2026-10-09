package de.smartcare.core.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.util.*;

/** Immutable navigation graph loaded from JSON (see resources/map/hospital.json). */
public final class HospitalMap {
    private final Map<String, MapNode> nodes = new LinkedHashMap<>();
    private final Map<String, MapEdge> edges = new LinkedHashMap<>();
    private final Map<String, List<MapEdge>> adjacency = new HashMap<>();
    private final Map<String, MapEdge> byPair = new HashMap<>();
    private final List<Zone> zones = new ArrayList<>();
    private final double width, height;

    private HospitalMap(double width, double height) { this.width = width; this.height = height; }

    public static HospitalMap load(InputStream in, double defaultStationCapacity) throws IOException {
        return load(in, defaultStationCapacity, 0, 0);
    }

    /**
     * Loads either the native format ({"world","nodes":[{id,x,y,kind}],"edges":[{a,b}]}) or the organizers' simulator
     * format (a JSON array of {node_id,x,y,charging_station,neghbour_nodes}). {@code width/height} (metres) size the
     * world when the file does not say; 0 = take the bounding box of the nodes.
     */
    public static HospitalMap load(InputStream in, double defaultStationCapacity, double width, double height) throws IOException {
        JsonNode root = new ObjectMapper().readTree(in);
        JsonNode firstNode = root.isArray() ? root.path(0) : root.path("nodes").path(0);
        if (root.isArray() || firstNode.has("node_id")) return loadSimulatorFormat(root.isArray() ? root : root.path("nodes"), defaultStationCapacity, width, height);
        JsonNode world = root.path("world");
        HospitalMap m = new HospitalMap(world.path("w").asDouble(100), world.path("h").asDouble(60));
        for (JsonNode n : root.withArray("nodes")) {
            NodeKind kind = NodeKind.valueOf(n.path("kind").asText("JUNCTION"));
            int cap = n.has("capacity") ? n.get("capacity").asInt() : (kind == NodeKind.JUNCTION ? 1 : (int) defaultStationCapacity);
            m.nodes.put(n.get("id").asText(), new MapNode(n.get("id").asText(), n.path("name").asText(n.get("id").asText()),
                    n.get("x").asDouble(), n.get("y").asDouble(), kind, cap));
        }
        for (JsonNode e : root.withArray("edges")) {
            String a = e.get("a").asText(), b = e.get("b").asText();
            MapNode na = m.requireNode(a), nb = m.requireNode(b);
            double len = e.has("length") ? e.get("length").asDouble() : na.pos().dist(nb.pos());
            MapEdge edge = new MapEdge(a + "-" + b, a, b, len, e.path("maxSpeed").asDouble(0));
            m.edges.put(edge.id(), edge);
            m.adjacency.computeIfAbsent(a, k -> new ArrayList<>()).add(edge);
            m.adjacency.computeIfAbsent(b, k -> new ArrayList<>()).add(edge);
            m.byPair.put(a + "|" + b, edge);
            m.byPair.put(b + "|" + a, edge);
        }
        for (JsonNode z : root.withArray("zones")) {
            Set<String> ns = new HashSet<>(), es = new HashSet<>();
            z.withArray("nodes").forEach(x -> ns.add(x.asText()));
            z.withArray("edges").forEach(x -> es.add(x.asText()));
            m.zones.add(new Zone(z.get("id").asText(), z.path("name").asText(z.get("id").asText()), ns, es, z.path("restricted").asBoolean(false)));
        }
        return m;
    }

    /** Display name for a simulator node id: "Charging_Station1_Hallway" -> "Charging Station 1". */
    public static String prettyName(String id) {
        return id.replace("_Hallway", "").replace('_', ' ').replaceAll("([A-Za-z])(\\d)", "$1 $2");
    }

    /** Station kind from the simulator's naming convention (Pharmacy_*, Ward*_*, Waypoint_* ...). */
    public static NodeKind kindOf(String id, boolean charging) {
        String s = id.toLowerCase(Locale.ROOT);
        if (charging || s.startsWith("charging")) return NodeKind.CHARGING;
        if (s.startsWith("or_") || s.equals("or")) return NodeKind.OR;
        if (s.startsWith("pharmacy")) return NodeKind.PHARMACY;
        if (s.startsWith("ward")) return NodeKind.WARD;
        if (s.startsWith("storage")) return NodeKind.STORAGE;
        if (s.startsWith("kitchen")) return NodeKind.KITCHEN;
        if (s.startsWith("laundry")) return NodeKind.LAUNDRY;
        if (s.startsWith("waste")) return NodeKind.WASTE;
        if (s.startsWith("check")) return NodeKind.CHECKIN;
        if (s.startsWith("lab")) return NodeKind.LAB;
        if (s.startsWith("cssd")) return NodeKind.CSSD;
        return NodeKind.JUNCTION;
    }

    private static HospitalMap loadSimulatorFormat(JsonNode nodes, double defaultStationCapacity, double width, double height) {
        double maxX = 0, maxY = 0;
        for (JsonNode n : nodes) { maxX = Math.max(maxX, n.get("x").asDouble()); maxY = Math.max(maxY, n.get("y").asDouble()); }
        HospitalMap m = new HospitalMap(width > 0 ? width : Math.ceil(maxX + 5), height > 0 ? height : Math.ceil(maxY + 5));
        Map<String, Set<String>> nb = new LinkedHashMap<>();
        for (JsonNode n : nodes) {
            String id = n.get("node_id").asText();
            NodeKind kind = n.has("kind") ? NodeKind.valueOf(n.get("kind").asText()) : kindOf(id, n.path("charging_station").asBoolean(false));
            int cap = n.has("capacity") ? n.get("capacity").asInt() : (kind == NodeKind.JUNCTION ? 1 : (int) defaultStationCapacity);
            m.nodes.put(id, new MapNode(id, n.path("name").asText(prettyName(id)), n.get("x").asDouble(), n.get("y").asDouble(), kind, cap));
            Set<String> set = new LinkedHashSet<>();
            n.path("neghbour_nodes").forEach(x -> set.add(x.asText()));   // sic: the simulator's spelling
            n.path("neighbour_nodes").forEach(x -> set.add(x.asText()));
            nb.put(id, set);
        }
        // An edge exists when both nodes list each other (same rule as the simulator's own visualizer).
        for (var en : nb.entrySet()) {
            String a = en.getKey();
            for (String b : en.getValue()) {
                MapNode na = m.requireNode(a), nb2 = m.requireNode(b);
                if (a.equals(b) || !nb.get(b).contains(a) || m.byPair.containsKey(a + "|" + b)) continue;
                MapEdge edge = new MapEdge(a + "-" + b, a, b, na.pos().dist(nb2.pos()), 0);
                m.edges.put(edge.id(), edge);
                m.adjacency.computeIfAbsent(a, k -> new ArrayList<>()).add(edge);
                m.adjacency.computeIfAbsent(b, k -> new ArrayList<>()).add(edge);
                m.byPair.put(a + "|" + b, edge);
                m.byPair.put(b + "|" + a, edge);
            }
        }
        return m;
    }

    private MapNode requireNode(String id) {
        MapNode n = nodes.get(id);
        if (n == null) throw new IllegalArgumentException("Unknown node in map file: " + id);
        return n;
    }

    public MapNode node(String id) { return nodes.get(id); }
    public MapEdge edge(String id) { return edges.get(id); }
    public MapEdge edgeBetween(String a, String b) { return byPair.get(a + "|" + b); }
    public Collection<MapNode> nodes() { return nodes.values(); }
    public Collection<MapEdge> edges() { return edges.values(); }
    public List<MapEdge> edgesOf(String node) { return adjacency.getOrDefault(node, List.of()); }
    public List<Zone> zones() { return zones; }
    public double width() { return width; }
    public double height() { return height; }
    public List<MapNode> chargers() { return nodes.values().stream().filter(MapNode::isCharger).toList(); }
    public List<MapNode> stations() { return nodes.values().stream().filter(MapNode::isStation).toList(); }

    /** Closest node to a point, if within {@code maxDist} metres. */
    public Optional<MapNode> nearest(double x, double y, double maxDist) {
        MapNode best = null; double bd = maxDist;
        for (MapNode n : nodes.values()) { double d = Math.hypot(n.x() - x, n.y() - y); if (d <= bd) { bd = d; best = n; } }
        return Optional.ofNullable(best);
    }

    public double pathLength(List<String> path) {
        double sum = 0;
        for (int i = 0; i + 1 < path.size(); i++) sum += edgeBetween(path.get(i), path.get(i + 1)).length();
        return sum;
    }
}
