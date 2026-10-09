package de.smartcare.core.vda;

import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.model.MapEdge;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.vda.Messages.*;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Builds VDA 5050 messages. Orders follow the base/horizon concept: nodes and edges up to {@code releasedIdx} are
 * released (the "base"), the rest is the horizon and the vehicle must not drive it until an order update releases it.
 * Sequence ids: node i = 2*i, edge between node i and i+1 = 2*i+1.
 */
public final class OrderFactory {
    private final HospitalMap map;
    private final String mapId;
    private final Map<String, AtomicLong> headers = new ConcurrentHashMap<>();

    public OrderFactory(HospitalMap map, String mapId) { this.map = map; this.mapId = mapId; }

    public long nextHeader(String serial, String kind) {
        return headers.computeIfAbsent(serial + "/" + kind, k -> new AtomicLong()).getAndIncrement();
    }

    public static String now() { return Instant.now().toString(); }

    /**
     * @param fromIdx first node index to include. 0 for a new order. For an order update it is the previous base end,
     *                because the update has to start at the node where the old base ended.
     */
    public Order order(String manufacturer, String serial, String orderId, long updateId, List<String> path,
                       int releasedIdx, int fromIdx, Map<Integer, List<Action>> nodeActions) {
        List<VdaNode> nodes = new ArrayList<>();
        List<VdaEdge> edges = new ArrayList<>();
        for (int i = fromIdx; i < path.size(); i++) {
            MapNode n = map.node(path.get(i));
            nodes.add(new VdaNode(n.id(), 2L * i, n.name(), i <= releasedIdx,
                    new NodePosition(n.x(), n.y(), null, 0.5, null, mapId, null),
                    nodeActions.getOrDefault(i, List.of())));
            if (i + 1 < path.size()) {
                MapEdge e = map.edgeBetween(path.get(i), path.get(i + 1));
                edges.add(new VdaEdge(e.id(), 2L * i + 1, null, i + 1 <= releasedIdx, path.get(i), path.get(i + 1),
                        e.maxSpeed() > 0 ? e.maxSpeed() : null, e.length(), List.of()));
            }
        }
        return new Order(nextHeader(serial, "order"), now(), Vda.VERSION, manufacturer, serial, orderId, updateId, null, nodes, edges);
    }

    public InstantActions instant(String manufacturer, String serial, Action... actions) {
        return new InstantActions(nextHeader(serial, "instantActions"), now(), Vda.VERSION, manufacturer, serial, List.of(actions));
    }

    public static Action action(String type, String id, String blocking, Map<String, Object> params) {
        List<ActionParameter> p = new ArrayList<>();
        if (params != null) params.forEach((k, v) -> p.add(new ActionParameter(k, v)));
        return new Action(type, id, null, blocking, p);
    }

    public static Action simple(String type, String id) { return action(type, id, Vda.Blocking.NONE, null); }
}
