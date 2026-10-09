package de.smartcare.core;

import de.smartcare.core.dispatch.Hungarian;
import de.smartcare.core.anomaly.Welford;
import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.mqtt.LoopbackBroker;
import de.smartcare.core.routing.Path;
import de.smartcare.core.routing.RouteConstraints;
import de.smartcare.core.routing.Router;
import de.smartcare.core.traffic.DeadlockDetector;
import de.smartcare.core.traffic.ReservationTable;
import de.smartcare.core.vda.*;
import de.smartcare.core.vda.Messages.*;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.*;

/** Pure-Java building blocks: routing, assignment, reservations, deadlock detection, VDA 5050 JSON, MQTT matching. */
class UnitTests {
    private HospitalMap map() throws Exception {
        try (var in = UnitTests.class.getResourceAsStream("/map/test-hospital.json")) { return HospitalMap.load(in, 3); }
    }

    // ───── routing ─────
    @Test @DisplayName("Dijkstra finds the shortest route and respects blocked edges")
    void routing() throws Exception {
        HospitalMap m = map();
        Router r = new Router(m, 4.0);
        Path p = r.shortest("PH", "WA", RouteConstraints.NONE).orElseThrow();
        assertEquals("PH", p.first());
        assertEquals("WA", p.last());
        assertTrue(p.nodes().contains("J2") || p.nodes().contains("LAB"));
        // block the direct corridor J2-J3: the route must avoid it
        r.block("J2-J3");
        Path q = r.shortest("PH", "WA", RouteConstraints.NONE).orElseThrow();
        for (int i = 0; i + 1 < q.nodes().size(); i++) {
            String a = q.nodes().get(i), b = q.nodes().get(i + 1);
            assertFalse((a.equals("J2") && b.equals("J3")) || (a.equals("J3") && b.equals("J2")));
        }
        assertTrue(q.timeS() >= p.timeS());
        // block everything around WA: no route
        r.block("J3-WA");
        assertTrue(r.shortest("PH", "WA", RouteConstraints.NONE).isEmpty());
    }

    @Test @DisplayName("Learned edge times change route choice")
    void learnedTimes() throws Exception {
        HospitalMap m = map();
        Router r = new Router(m, 4.0);
        Path before = r.shortest("J1", "J2", RouteConstraints.NONE).orElseThrow();
        assertEquals(List.of("J1", "J2"), before.nodes());
        for (int i = 0; i < 5; i++) r.observe("J1-J2", 500);     // corridor is in reality very slow
        Path after = r.shortest("J1", "J2", RouteConstraints.NONE).orElseThrow();
        assertNotEquals(List.of("J1", "J2"), after.nodes());
    }

    @Test @DisplayName("Congestion penalty diverts routes")
    void congestionPenalty() throws Exception {
        Router r = new Router(map(), 4.0);
        r.setCongestionPenalty(e -> e.equals("J1-J2") ? 1000 : 0);
        assertNotEquals(List.of("J1", "J2"), r.shortest("J1", "J2", RouteConstraints.NONE).orElseThrow().nodes());
        assertEquals(List.of("J1", "J2"), r.shortestIgnoringTraffic("J1", "J2").orElseThrow().nodes());
    }

    // ───── Hungarian ─────
    @Test @DisplayName("Hungarian assignment is optimal (compared with brute force)")
    void hungarian() {
        Random rnd = new Random(42);
        for (int round = 0; round < 200; round++) {
            int n = 1 + rnd.nextInt(5), m = n + rnd.nextInt(3);
            double[][] c = new double[n][m];
            for (double[] row : c) for (int j = 0; j < m; j++) row[j] = rnd.nextInt(100);
            int[] a = Hungarian.solve(c);
            double got = 0;
            Set<Integer> used = new HashSet<>();
            for (int i = 0; i < n; i++) { got += c[i][a[i]]; assertTrue(used.add(a[i]), "column used twice"); }
            assertEquals(brute(c, 0, new boolean[m]), got, 1e-9);
        }
    }

    private double brute(double[][] c, int row, boolean[] used) {
        if (row == c.length) return 0;
        double best = Double.MAX_VALUE;
        for (int j = 0; j < c[0].length; j++) if (!used[j]) { used[j] = true; best = Math.min(best, c[row][j] + brute(c, row + 1, used)); used[j] = false; }
        return best;
    }

    // ───── reservations / deadlocks ─────
    @Test @DisplayName("Edges are single lane, junctions hold one robot, stations several")
    void reservations() throws Exception {
        HospitalMap m = map();
        ReservationTable t = new ReservationTable(m);
        assertTrue(t.tryReserve("A", "J1-J2", "J2").isEmpty());
        assertEquals(Set.of("A"), t.tryReserve("B", "J1-J2", "J2"));
        assertEquals(Set.of("A"), t.tryReserve("B", "J2-J3", "J2"));   // junction already taken
        t.releaseEdge("A", "J1-J2"); t.releaseNode("A", "J2");
        assertTrue(t.tryReserve("B", "J1-J2", "J2").isEmpty());
        // ward capacity 3
        assertTrue(t.tryReserve("A", "J3-WA", "WA").isEmpty());
        t.releaseEdge("A", "J3-WA");
        assertTrue(t.tryReserve("C", "J3-WA", "WA").isEmpty());
        t.releaseEdge("C", "J3-WA");
        assertTrue(t.tryReserve("D", "J3-WA", "WA").isEmpty());
        t.releaseEdge("D", "J3-WA");
        assertFalse(t.tryReserve("E", "J3-WA", "WA").isEmpty());
    }

    @Test @DisplayName("Wait-for cycles are detected, chains are not")
    void deadlocks() {
        assertEquals(1, DeadlockDetector.cycles(Map.of("A", Set.of("B"), "B", Set.of("C"), "C", Set.of("A"))).size());
        assertEquals(1, DeadlockDetector.cycles(Map.of("A", Set.of("B"), "B", Set.of("A"))).size());
        assertTrue(DeadlockDetector.cycles(Map.of("A", Set.of("B"), "B", Set.of("C"))).isEmpty());
        assertTrue(DeadlockDetector.cycles(Map.of()).isEmpty());
    }

    // ───── statistics ─────
    @Test @DisplayName("Welford z-score")
    void welford() {
        Welford w = new Welford();
        for (double v : new double[]{10, 12, 11, 9, 10, 11, 10, 12}) w.add(v);
        assertEquals(10.625, w.mean(), 1e-9);
        assertTrue(w.z(30) > 5);
        assertTrue(Math.abs(w.z(10.5)) < 1);
    }

    // ───── VDA 5050 ─────
    @Test @DisplayName("VDA 5050 order JSON round trip uses the standard field names")
    void vdaOrder() throws Exception {
        HospitalMap m = map();
        OrderFactory f = new OrderFactory(m, "hospital-f1");
        Order o = f.order("SmartCareSim", "AMR-1", "o-1", 0, List.of("PH", "T1", "J1"), 1, 0,
                Map.of(2, List.of(OrderFactory.action(Vda.ActionType.DROP, "a1", Vda.Blocking.HARD, Map.of("taskId", "T-1")))));
        Codec codec = new Codec();
        String json = codec.toJson(o);
        for (String k : new String[]{"\"headerId\"", "\"timestamp\"", "\"version\":\"2.0.0\"", "\"manufacturer\"", "\"serialNumber\"", "\"orderId\"",
                "\"orderUpdateId\"", "\"nodes\"", "\"edges\"", "\"nodeId\"", "\"sequenceId\"", "\"released\"", "\"nodePosition\"", "\"mapId\"",
                "\"startNodeId\"", "\"endNodeId\"", "\"actionType\":\"drop\"", "\"blockingType\":\"HARD\"", "\"actionParameters\""})
            assertTrue(json.contains(k), "missing " + k + " in " + json);
        Order back = codec.fromJson(json, Order.class);
        assertEquals(o, back);
        assertEquals(3, back.nodes().size());
        assertEquals(2, back.edges().size());
        // base/horizon: nodes 0 and 1 released, node 2 is horizon
        assertTrue(back.nodes().get(1).released());
        assertFalse(back.nodes().get(2).released());
        assertEquals(0L, back.nodes().get(0).sequenceId());
        assertEquals(1L, back.edges().get(0).sequenceId());
        assertEquals(2L, back.nodes().get(1).sequenceId());
        assertTrue(back.edges().get(0).released());
        assertFalse(back.edges().get(1).released());
    }

    @Test @DisplayName("Order update starts at the previous base end")
    void orderUpdate() throws Exception {
        OrderFactory f = new OrderFactory(map(), "hospital-f1");
        Order u = f.order("M", "S", "o-1", 1, List.of("PH", "T1", "J1", "J2"), 2, 1, Map.of());
        assertEquals("T1", u.nodes().get(0).nodeId());
        assertEquals(2L, u.nodes().get(0).sequenceId());
        assertEquals(3, u.nodes().size());
        assertTrue(u.nodes().get(1).released());
        assertFalse(u.nodes().get(2).released());
        assertEquals(1L, u.orderUpdateId());
    }

    @Test @DisplayName("State parsing ignores unknown fields and header ids increase")
    void vdaState() {
        String json = "{\"headerId\":7,\"timestamp\":\"2026-01-01T00:00:00Z\",\"version\":\"2.0.0\",\"manufacturer\":\"X\",\"serialNumber\":\"S1\","
                + "\"orderId\":\"o\",\"orderUpdateId\":0,\"lastNodeId\":\"J1\",\"lastNodeSequenceId\":4,\"driving\":true,\"operatingMode\":\"AUTOMATIC\","
                + "\"nodeStates\":[],\"edgeStates\":[],\"batteryState\":{\"batteryCharge\":55.5,\"charging\":false,\"someVendorField\":1},"
                + "\"errors\":[],\"actionStates\":[{\"actionId\":\"a\",\"actionStatus\":\"FINISHED\"}],\"safetyState\":{\"eStop\":\"NONE\",\"fieldViolation\":false},\"vendorExtra\":{}}";
        State s = new Codec().fromJson(json, State.class);
        assertEquals("J1", s.lastNodeId());
        assertEquals(55.5, s.batteryState().batteryCharge(), 1e-9);
        assertEquals("FINISHED", s.actionStates().get(0).actionStatus());
        OrderFactory f = new OrderFactory(null, "m");
        assertEquals(0L, f.nextHeader("S", "state"));
        assertEquals(1L, f.nextHeader("S", "state"));
        assertEquals(0L, f.nextHeader("S", "order"));
    }

    @Test @DisplayName("Topic names follow interfaceName/majorVersion/manufacturer/serial/topic")
    void topics() {
        Topics t = new Topics("uagv", "v2");
        assertEquals("uagv/v2/ACME/R1/order", t.order("ACME", "R1"));
        assertEquals("uagv/v2/ACME/R1/instantActions", t.instantActions("ACME", "R1"));
        assertEquals("uagv/v2/+/+/state", t.allStates());
        assertEquals(List.of("ACME", "R1", "state").toString(), Arrays.asList(t.parse("uagv/v2/ACME/R1/state")).toString());
        assertNull(t.parse("other/v2/ACME/R1/state"));
    }

    // ───── MQTT ─────
    @Test @DisplayName("MQTT wildcard matching and retained messages")
    void mqtt() {
        assertTrue(LoopbackBroker.matches("a/+/c", "a/b/c"));
        assertFalse(LoopbackBroker.matches("a/+/c", "a/b/d"));
        assertTrue(LoopbackBroker.matches("a/#", "a/b/c/d"));
        assertFalse(LoopbackBroker.matches("a/+", "a/b/c"));
        LoopbackBroker b = new LoopbackBroker();
        b.publish("x/y", "kept", true);
        List<String> got = new CopyOnWriteArrayList<>();
        b.subscribe("x/+", (t, p) -> got.add(p));
        b.publish("x/z", "live", false);
        assertEquals(List.of("kept", "live"), got);
    }

    // ───── configuration ─────
    @Test @DisplayName("Settings are bound from kebab-case and camelCase properties with type checks")
    void settingsBinding() {
        Map<String, String> p = new HashMap<>();
        p.put("smartcare.mqtt.mode", "BROKER");
        p.put("smartcare.mqtt.host", "mosquitto");
        p.put("smartcare.energy.low-pct", "35");
        p.put("smartcare.energy.criticalPct", "12.5");
        p.put("smartcare.dispatch.hungarian", "false");
        p.put("smartcare.core.tick-ms", "100");
        var s = de.smartcare.core.settings.SettingsBinder.bind(p::get);
        assertEquals("BROKER", s.mqtt.mode);
        assertEquals("mosquitto", s.mqtt.host);
        assertEquals(35.0, s.energy.lowPct, 1e-9);
        assertEquals(12.5, s.energy.criticalPct, 1e-9);
        assertFalse(s.dispatch.hungarian);
        assertEquals(100L, s.core.tickMs);
        assertEquals(1883, s.mqtt.port);                    // untouched default
        p.put("smartcare.mqtt.port", "abc");
        assertThrows(IllegalArgumentException.class, () -> de.smartcare.core.settings.SettingsBinder.bind(p::get));
    }

    @Test @DisplayName("The core map matches the floor plan hard-coded in the UI (ids, coordinates, edge ids)")
    void mapParityWithUi() throws Exception {
        HospitalMap m = map();
        String[][] pairs = {{"WD","J1"},{"J1","J2"},{"J2","J3"},{"J3","WA"},{"J1","T1"},{"J3","T2"},{"T1","LAB"},{"LAB","T2"},{"J2","LAB"},{"PH","T1"},
                {"T2","OR"},{"J1","B1"},{"J2","WC"},{"J3","B3"},{"B1","WC"},{"WC","B3"},{"B1","CSSD"},{"B3","WB"},{"WC","CHG"}};
        assertEquals(pairs.length, m.edges().size());
        for (String[] pr : pairs) assertNotNull(m.edge(pr[0] + "-" + pr[1]), "missing edge " + pr[0] + "-" + pr[1]);
        assertEquals(16, m.nodes().size());
        assertEquals(10.0, m.node("PH").x(), 1e-9); assertEquals(12.0, m.node("PH").y(), 1e-9);
        assertEquals(92.0, m.node("WA").x(), 1e-9); assertEquals(30.0, m.node("WA").y(), 1e-9);
        assertEquals(50.0, m.node("CHG").x(), 1e-9); assertEquals(58.0, m.node("CHG").y(), 1e-9);
        assertEquals(100.0, m.width(), 1e-9); assertEquals(62.0, m.height(), 1e-9);
    }
}
