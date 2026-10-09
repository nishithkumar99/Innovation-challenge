package de.smartcare.core;

import de.smartcare.core.vda.*;
import de.smartcare.core.vda.Messages.*;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/** The STEPWISE adapter between the core's base/horizon orders and a vehicle without horizon support (organizers' simulator). */
class SegmentedOrdersTests {
    private final List<Order> sent = new ArrayList<>();
    private long now = 10_000;
    private final SegmentedOrders so = new SegmentedOrders((m, s, o) -> sent.add(o), () -> now);

    private static VdaNode node(String id, long seq, boolean released, List<Action> acts) {
        return new VdaNode(id, seq, null, released, new NodePosition(seq, 0, null, null, null, "webots", null), acts);
    }
    private static VdaEdge edge(long seq, String a, String b, boolean released) {
        return new VdaEdge(a + "-" + b, seq, null, released, a, b, null, null, List.of());
    }
    private static Order order(String id, long upd, List<VdaNode> n, List<VdaEdge> e) {
        return new Order(1, "t", "2.0.0", "rikeb", "AMR1", id, upd, null, n, e);
    }
    private static State state(String orderId, String last, long seq, List<NodeState> ns, List<EdgeState> es) {
        return new State(1, "t", "2.0.0", "rikeb", "AMR1", orderId, 0, null, last, seq, false, null, null, 0.0, "AUTOMATIC",
                ns, es, null, null, List.of(), null, List.of(), List.of(), List.of(), null);
    }
    private static State idle(String orderId, String last, long seq) { return state(orderId, last, seq, List.of(), List.of()); }

    private Order threeNodes(boolean releaseAll) {
        return order("O1", 0, List.of(node("A", 0, true, List.of()), node("B", 2, true, List.of()), node("C", 4, releaseAll, List.of())),
                List.of(edge(1, "A", "B", true), edge(3, "B", "C", releaseAll)));
    }

    @Test @DisplayName("only the released stretch is sent, under a unique sub-order id")
    void releasedStretchOnly() {
        so.inbound("AMR1", idle("old", "A", 0));
        so.submit("rikeb", "AMR1", threeNodes(false));
        assertEquals(1, sent.size());
        Order o = sent.get(0);
        assertEquals("O1~1", o.orderId());
        assertEquals(List.of("A", "B"), o.nodes().stream().map(VdaNode::nodeId).toList());
        assertEquals(0, o.orderUpdateId());
    }

    @Test @DisplayName("the next stretch follows only after the vehicle has finished the previous one and more is released")
    void nextStretch() {
        so.inbound("AMR1", idle("old", "A", 0));
        so.submit("rikeb", "AMR1", threeNodes(false));
        so.inbound("AMR1", state("O1~1", "A", 0, List.of(new NodeState("B", 2, null, null, true)), List.of(new EdgeState("A-B", 1, null, true))));
        so.submit("rikeb", "AMR1", order("O1", 1, List.of(node("C", 4, true, List.of())), List.of(edge(3, "B", "C", true))));
        assertEquals(1, sent.size(), "previous stretch still driving");
        State seen = so.inbound("AMR1", idle("O1~1", "B", 2));
        assertEquals(2, sent.size());
        assertEquals("O1~2", sent.get(1).orderId());
        assertEquals(List.of("B", "C"), sent.get(1).nodes().stream().map(VdaNode::nodeId).toList());
        assertEquals("O1", seen.orderId(), "the core sees its own order id");
    }

    @Test @DisplayName("an unacknowledged order is re-sent after 2.5 s")
    void resend() {
        so.inbound("AMR1", idle("old", "A", 0));
        so.submit("rikeb", "AMR1", threeNodes(true));
        assertEquals(1, sent.size());
        now += 1000; so.tick();
        assertEquals(1, sent.size());
        now += 2000; so.tick();
        assertEquals(2, sent.size());
        assertEquals(sent.get(0).orderId(), sent.get(1).orderId());
    }

    @Test @DisplayName("pause holds the next stretch back and is not forwarded; resume releases it")
    void pause() {
        so.inbound("AMR1", idle("old", "A", 0));
        so.submit("rikeb", "AMR1", threeNodes(false));
        so.inbound("AMR1", idle("O1~1", "B", 2));
        assertEquals(1, sent.size());
        assertFalse(so.instantAction("AMR1", new Action("startPause", "a1", null, "HARD", List.of())));
        so.submit("rikeb", "AMR1", order("O1", 1, List.of(node("C", 4, true, List.of())), List.of(edge(3, "B", "C", true))));
        assertEquals(1, sent.size(), "paused");
        assertFalse(so.instantAction("AMR1", new Action("stopPause", "a2", null, "HARD", List.of())));
        assertEquals(2, sent.size());
    }

    @Test @DisplayName("cancelOrder is forwarded, drops the order and holds new orders for 1.2 s")
    void cancel() {
        so.inbound("AMR1", idle("old", "A", 0));
        so.submit("rikeb", "AMR1", threeNodes(false));
        assertTrue(so.instantAction("AMR1", new Action("cancelOrder", "c1", null, "HARD", List.of())));
        so.submit("rikeb", "AMR1", order("O2", 0, List.of(node("A", 0, true, List.of()), node("B", 2, true, List.of())), List.of(edge(1, "A", "B", true))));
        assertEquals(1, sent.size(), "held back right after cancel");
        now += 1300; so.tick();
        assertEquals(2, sent.size());
        assertTrue(sent.get(1).orderId().startsWith("O2~"));
    }

    @Test @DisplayName("a single-node order with an action is issued; the first node's actions are stripped otherwise")
    void actions() {
        so.inbound("AMR1", idle("old", "A", 0));
        Action pick = new Action("pick", "p1", null, "HARD", List.of());
        so.submit("rikeb", "AMR1", order("S1", 0, List.of(node("A", 0, true, List.of(pick))), List.of()));
        assertEquals(1, sent.size());
        assertEquals(1, sent.get(0).nodes().get(0).actions().size());
        sent.clear();
        so.inbound("AMR1", idle("S1~1", "A", 0));
        so.submit("rikeb", "AMR1", order("S2", 0, List.of(node("A", 0, true, List.of(pick)), node("B", 2, true, List.of(pick))),
                List.of(edge(1, "A", "B", true))));
        Order o = sent.get(0);
        assertTrue(o.nodes().get(0).actions().isEmpty());
        assertEquals(1, o.nodes().get(1).actions().size());
    }
}
