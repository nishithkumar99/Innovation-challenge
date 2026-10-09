package de.smartcare.core;

import de.smartcare.core.event.Dto;
import de.smartcare.core.event.Envelope;
import de.smartcare.core.task.Task;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/** End-to-end scenarios: core + VDA 5050 simulator over (loopback) MQTT on a virtual clock. */
class ScenarioTests {
    private static String task(Rig r, String from, String to, String prio) {
        return r.core.createTask("PHARMACY", from, to, prio, "item", null, "REAL", "u1", "Tester");
    }
    private static boolean delivered(Rig r, String id) { return r.core.task(id).status == Task.Status.DELIVERED; }

    // ───── task distribution ─────
    @Test @DisplayName("A task is delivered end to end")
    void delivery() {
        Rig r = new Rig(2);
        String id = task(r, "PH", "WA", "URGENT");
        assertTrue(r.advanceUntil(120, () -> delivered(r, id)), "not delivered, status " + r.core.task(id).status);
        Task t = r.core.task(id);
        assertEquals("AMR-1", t.robotId);            // AMR-1 stands at the pharmacy
        assertNotNull(t.assignedAt);
        assertNotNull(t.pickedAt);
        assertTrue(t.pickedAt <= t.deliveredAt);
        assertTrue(r.sim.battery("AMR-1") < 85);
    }

    @Test @DisplayName("The nearest vehicle is chosen")
    void nearest() {
        Rig r = new Rig(3, c -> c.sim.startNodes = "WD,OR,CSSD");
        String id = task(r, "WD", "WA", "ROUTINE");
        r.advance(2);
        assertEquals("AMR-1", r.core.task(id).robotId);
    }

    @Test @DisplayName("STAT work is served before ROUTINE work when vehicles are scarce")
    void priority() {
        Rig r = new Rig(1, c -> c.sim.startNodes = "PH");
        String routine = task(r, "PH", "WA", "ROUTINE");
        r.clock.addAndGet(1000);
        String stat = task(r, "PH", "WB", "STAT");
        assertTrue(r.advanceUntil(200, () -> delivered(r, stat)));
        assertFalse(delivered(r, routine), "routine must not overtake STAT");
        assertTrue(r.advanceUntil(200, () -> delivered(r, routine)));
    }

    @Test @DisplayName("Many tasks are balanced over the fleet and all delivered")
    void loadBalancing() {
        Rig r = new Rig(4);
        String[][] routes = {{"PH", "WA"}, {"LAB", "WB"}, {"CSSD", "WC"}, {"WD", "OR"}, {"PH", "WB"}, {"LAB", "WA"}, {"CSSD", "OR"}, {"WD", "WC"}};
        List<String> ids = new ArrayList<>();
        for (String[] rt : routes) ids.add(task(r, rt[0], rt[1], "ROUTINE"));
        assertTrue(r.advanceUntil(900, () -> ids.stream().allMatch(i -> delivered(r, i))), "not all delivered");
        Set<String> used = new HashSet<>();
        for (String i : ids) used.add(r.core.task(i).robotId);
        assertTrue(used.size() >= 3, "work was concentrated on " + used);
    }

    @Test @DisplayName("Vehicles never share a single-lane corridor or a junction")
    void noCollisions() {
        Rig r = new Rig(5);
        String[][] routes = {{"PH", "WA"}, {"WA", "PH"}, {"LAB", "WB"}, {"WB", "LAB"}, {"CSSD", "WC"}, {"WC", "CSSD"}, {"WD", "OR"}, {"OR", "WD"}, {"PH", "WB"}, {"WB", "PH"}};
        List<String> ids = new ArrayList<>();
        for (String[] rt : routes) ids.add(task(r, rt[0], rt[1], "URGENT"));
        double minDist = Double.MAX_VALUE;
        for (int step = 0; step < 6000 && !ids.stream().allMatch(i -> delivered(r, i)); step++) {
            r.advance(0.1);
            var robots = r.core.robotsSnapshot();
            for (int a = 0; a < robots.size(); a++) for (int b = a + 1; b < robots.size(); b++) {
                var p = robots.get(a).pos(); var q = robots.get(b).pos();
                double d = Math.hypot(p.x() - q.x(), p.y() - q.y());
                // stations may hold several vehicles at once (capacity 3); everywhere else they must keep apart
                boolean atStation = r.map.stations().stream().anyMatch(n -> Math.hypot(n.x() - p.x(), n.y() - p.y()) < 0.5 && Math.hypot(n.x() - q.x(), n.y() - q.y()) < 0.5);
                if (!atStation) minDist = Math.min(minDist, d);
            }
        }
        assertTrue(ids.stream().allMatch(i -> delivered(r, i)), "not all delivered");
        assertTrue(minDist > 1.0, "vehicles came closer than 1 m: " + minDist);
    }

    // ───── traffic ─────
    @Test @DisplayName("A head-on deadlock is detected and resolved by re-routing")
    void deadlock() {
        Rig r = new Rig(2, c -> { c.sim.startNodes = "J1,J2"; c.traffic.deadlockMinWaitS = 3; });
        String a = task(r, "J1", "J2", "ROUTINE");
        String b = task(r, "J2", "J1", "ROUTINE");
        assertTrue(r.advanceUntil(200, () -> delivered(r, a) && delivered(r, b)), "deadlock not resolved: " + r.core.task(a).status + "/" + r.core.task(b).status);
        assertTrue((Integer) r.core.diagnostics().get("deadlocksResolved") >= 1);
        boolean raised = r.core.insights().stream().anyMatch(i -> i.title().startsWith("Deadlock"));
        assertTrue(raised, "deadlock insight missing");
    }

    @Test @DisplayName("Blocking a corridor re-routes traffic around it")
    void blockedZone() {
        Rig r = new Rig(1, c -> c.sim.startNodes = "PH");
        List<Envelope> seen = new ArrayList<>();
        r.core.context().bus.subscribe(seen::add);
        r.core.command(new Dto.CommandRequest("BLOCK_ZONE", "J2-J3", Map.of(), null, null), "c1", "u-op");
        String id = task(r, "PH", "WA", "URGENT");
        assertTrue(r.advanceUntil(300, () -> delivered(r, id)));
        assertTrue(seen.stream().anyMatch(e -> e.topic().equals("commands.acks") && ((Dto.CommandAck) e.payload()).state().equals("DONE")));
        assertTrue(r.core.snapshot().system().blockedZones().contains("J2-J3"));
    }

    // ───── energy ─────
    @Test @DisplayName("A low battery sends an idle vehicle to the charger and releases it when charged")
    void charging() {
        Rig r = new Rig(1, c -> c.sim.startNodes = "WC");
        r.sim.setBattery("AMR-1", 25);
        assertTrue(r.advanceUntil(60, () -> r.core.robotsSnapshot().get(0).status().equals("CHARGING")), "never charging");
        assertEquals("CHG", r.sim.node("AMR-1"));
        assertTrue(r.advanceUntil(200, () -> r.sim.battery("AMR-1") >= 90 && !r.core.robotsSnapshot().get(0).status().equals("CHARGING")), "not released");
    }

    @Test @DisplayName("A vehicle below the critical limit gets no work, a charged one does")
    void noWorkWhenCritical() {
        Rig r = new Rig(1, c -> c.sim.startNodes = "PH");
        r.sim.setBattery("AMR-1", 10);
        r.advance(1);
        String id = task(r, "PH", "WA", "STAT");
        r.advance(5);
        assertEquals(Task.Status.QUEUED, r.core.task(id).status);
        assertTrue(r.advanceUntil(300, () -> delivered(r, id)), "task should be served after charging");
    }

    @Test @DisplayName("Opportunistic charging when idle and below the threshold")
    void opportunistic() {
        Rig r = new Rig(1, c -> c.sim.startNodes = "PH");
        r.sim.setBattery("AMR-1", 55);
        assertTrue(r.advanceUntil(60, () -> "CHARGING".equals(r.core.robotsSnapshot().get(0).status())));
    }

    // ───── anomaly detection ─────
    @Test @DisplayName("A stalled vehicle raises a critical insight")
    void stalled() {
        Rig r = new Rig(1, c -> { c.sim.startNodes = "PH"; c.anomaly.noProgressS = 10; });
        task(r, "PH", "WA", "URGENT");
        r.advance(8);
        r.sim.setFrozen("AMR-1", true);
        assertTrue(r.advanceUntil(40, () -> r.core.insights().stream().anyMatch(i -> i.title().contains("not making progress") && i.severity().equals("CRITICAL"))), "no stall insight");
    }

    @Test @DisplayName("An unprocessed order is reported")
    void unprocessed() {
        Rig r = new Rig(1, c -> { c.sim.startNodes = "PH"; c.anomaly.queuedWarnS = 12; });
        r.sim.setBattery("AMR-1", 10);   // cannot serve
        r.advance(1);
        r.core.command(new Dto.CommandRequest("FLEET_HOLD", null, null, null, null), "h", "u");
        task(r, "PH", "WA", "ROUTINE");
        assertTrue(r.advanceUntil(30, () -> r.core.insights().stream().anyMatch(i -> i.title().contains("without a robot"))));
    }

    @Test @DisplayName("Long idle time is reported")
    void idle() {
        Rig r = new Rig(1, c -> { c.sim.startNodes = "PH"; c.anomaly.idleWarnS = 20; });
        assertTrue(r.advanceUntil(40, () -> r.core.insights().stream().anyMatch(i -> i.title().contains("idle"))));
    }

    @Test @DisplayName("Abnormal battery consumption of one vehicle is flagged by z-score")
    void batteryAnomaly() {
        Rig r = new Rig(2, c -> { c.sim.startNodes = "PH,LAB"; c.anomaly.minSamples = 4; c.energy.opportunisticBelowPct = 0; c.energy.lowPct = 5; c.energy.criticalPct = 1; });
        // build a baseline with normal consumption
        String[][] routes = {{"PH", "WA"}, {"LAB", "WB"}, {"WA", "PH"}, {"WB", "LAB"}, {"PH", "WC"}, {"LAB", "OR"}, {"WC", "PH"}, {"OR", "LAB"}};
        List<String> ids = new ArrayList<>();
        for (String[] rt : routes) ids.add(task(r, rt[0], rt[1], "ROUTINE"));
        assertTrue(r.advanceUntil(900, () -> ids.stream().allMatch(i -> delivered(r, i))));
        // now AMR-2 starts consuming 3x more
        r.sim.setDrainMultiplier("AMR-2", 3);
        List<String> more = new ArrayList<>();
        for (int i = 0; i < 3; i++) { more.add(task(r, "WB", "LAB", "ROUTINE")); more.add(task(r, "WA", "PH", "ROUTINE")); }
        assertTrue(r.advanceUntil(900, () -> more.stream().allMatch(i -> delivered(r, i))));
        assertTrue(r.core.insights().stream().anyMatch(i -> i.title().contains("unusually much energy")), "no battery insight: " + r.core.insights());
    }

    @Test @DisplayName("An offline vehicle is detected and its task is handed to another")
    void offline() {
        Rig r = new Rig(2, c -> { c.sim.startNodes = "PH,LAB"; c.core.robotOfflineS = 5; });
        String id = task(r, "PH", "WA", "URGENT");
        r.advance(6);
        assertEquals("AMR-1", r.core.task(id).robotId);
        r.sim.disconnect("AMR-1");
        assertTrue(r.advanceUntil(300, () -> delivered(r, id)), "task not completed after robot loss");
        assertEquals("AMR-2", r.core.task(id).robotId);
        assertTrue(r.core.insights().stream().anyMatch(i -> i.title().contains("AMR-1 is offline")));
    }

    // ───── prediction ─────
    @Test @DisplayName("Forecast shows hotspots when many vehicles share a corridor")
    void forecast() {
        Rig r = new Rig(5, c -> c.traffic.predictionLoadThreshold = 0.1);
        for (int i = 0; i < 15; i++) { task(r, "PH", "WA", "ROUTINE"); task(r, "WD", "WB", "ROUTINE"); }
        r.advance(15);
        var snap = r.core.snapshot();
        assertFalse(snap.predictions().isEmpty(), "no predictions");
        assertTrue(snap.predictions().stream().allMatch(h -> h.severity() > 0 && h.severity() <= 1));
    }

    // ───── operator commands ─────
    @Test @DisplayName("Operator commands: pause, cancel, reassign, priority, hold")
    void commands() {
        Rig r = new Rig(2, c -> c.sim.startNodes = "PH,LAB");
        List<Envelope> acks = new ArrayList<>();
        r.core.context().bus.subscribe(e -> { if (e.topic().equals("commands.acks")) acks.add(e); });

        String t1 = task(r, "PH", "WA", "ROUTINE");
        r.advance(3);
        r.core.command(new Dto.CommandRequest("PAUSE", "AMR-1", Map.of(), null, null), "p1", "u");
        r.advance(2);
        double x = r.core.robotsSnapshot().get(0).pos().x();
        r.advance(3);
        assertEquals(x, r.core.robotsSnapshot().get(0).pos().x(), 1e-6);
        assertEquals("PAUSED", r.core.robotsSnapshot().get(0).status());
        r.core.command(new Dto.CommandRequest("RESUME", "AMR-1", Map.of(), null, null), "p2", "u");
        assertTrue(r.advanceUntil(200, () -> delivered(r, t1)));

        String t2 = task(r, "LAB", "WB", "ROUTINE");
        r.advance(1);
        r.core.command(new Dto.CommandRequest("SET_PRIORITY", t2, Map.of("priority", "STAT"), null, null), "s1", "u");
        assertEquals(Task.Priority.STAT, r.core.task(t2).priority);
        r.core.command(new Dto.CommandRequest("CANCEL_TASK", t2, Map.of(), null, null), "c1", "u");
        assertEquals(Task.Status.CANCELLED, r.core.task(t2).status);

        r.core.command(new Dto.CommandRequest("FLEET_HOLD", null, Map.of(), null, null), "h1", "u");
        String t3 = task(r, "PH", "WA", "STAT");
        r.advance(5);
        assertEquals(Task.Status.QUEUED, r.core.task(t3).status);
        r.core.command(new Dto.CommandRequest("FLEET_RESUME", null, Map.of(), null, null), "h2", "u");
        assertTrue(r.advanceUntil(200, () -> delivered(r, t3)));

        r.core.command(new Dto.CommandRequest("CANCEL_TASK", "T-nope", Map.of(), null, null), "bad", "u");
        Dto.CommandAck last = (Dto.CommandAck) acks.get(acks.size() - 1).payload();
        assertEquals("REJECTED", last.state());
        assertTrue(acks.stream().anyMatch(e -> ((Dto.CommandAck) e.payload()).correlationId().equals("p1") && ((Dto.CommandAck) e.payload()).state().equals("DONE")));
    }

    @Test @DisplayName("Reassigning moves the task to another vehicle")
    void reassign() {
        Rig r = new Rig(2, c -> c.sim.startNodes = "PH,LAB");
        String id = task(r, "PH", "WA", "ROUTINE");
        r.advance(2);
        assertEquals("AMR-1", r.core.task(id).robotId);
        r.core.command(new Dto.CommandRequest("REASSIGN", id, Map.of(), null, null), "r1", "u");
        assertTrue(r.advanceUntil(300, () -> delivered(r, id)));
        assertEquals("AMR-2", r.core.task(id).robotId);
    }

    @Test @DisplayName("Applying an insight executes its suggested command")
    void applyInsight() {
        Rig r = new Rig(1, c -> { c.sim.startNodes = "PH"; c.anomaly.noProgressS = 5; });
        task(r, "PH", "WA", "URGENT");
        r.advance(6);
        r.sim.setFrozen("AMR-1", true);
        assertTrue(r.advanceUntil(30, () -> r.core.insights().stream().anyMatch(i -> i.suggestion() != null)));
        var ins = r.core.insights().stream().filter(i -> i.suggestion() != null).findFirst().orElseThrow();
        r.core.applyInsight(ins.id(), "ap1", "u-op");
        assertEquals("MANUAL_OVERRIDE", r.core.robotsSnapshot().get(0).status());
        assertEquals("ACTION_APPLIED", r.core.insights().stream().filter(i -> i.id().equals(ins.id())).findFirst().orElseThrow().state());
    }

    // ───── API contract ─────
    @Test @DisplayName("Snapshot and KPI follow the shape the UI expects")
    void snapshotShape() throws Exception {
        Rig r = new Rig(2);
        String id = task(r, "PH", "WA", "URGENT");
        assertTrue(r.advanceUntil(120, () -> delivered(r, id)));
        r.advance(2);
        var snap = r.core.snapshot();
        String json = new de.smartcare.core.vda.Codec().toJson(snap);
        for (String k : new String[]{"\"robots\"", "\"zones\"", "\"stations\"", "\"predictions\"", "\"tasks\"", "\"insights\"", "\"kpi\"", "\"system\"",
                "\"seq\"", "\"avgTaskSec\"", "\"wait\"", "\"methodologyVersion\"", "\"blockedZones\"", "\"aiAvailable\""})
            assertTrue(json.contains(k), "missing " + k);
        assertTrue(snap.kpi().avgTaskSec() > 0);
        assertEquals(9, snap.stations().size());   // PH, LAB, CSSD, OR, WD, WA, WB, WC, CHG
    }

    @Test @DisplayName("Validation catches bad requests")
    void validation() {
        Rig r = new Rig(1);
        assertFalse(r.core.validateTask("PH", "PH", "ROUTINE").ok());
        assertFalse(r.core.validateTask("PH", "CHG", "ROUTINE").ok());
        assertFalse(r.core.validateTask("XX", "WA", "ROUTINE").ok());
        assertTrue(r.core.validateTask("PH", "WA", "ROUTINE").ok());
        assertThrows(IllegalArgumentException.class, () -> task(r, "PH", "PH", "ROUTINE"));
    }

    @Test @DisplayName("Event sequence numbers are gap free")
    void sequence() {
        Rig r = new Rig(2);
        List<Long> seqs = new ArrayList<>();
        r.core.context().bus.subscribe(e -> seqs.add(e.seq()));
        String id = task(r, "PH", "WA", "URGENT");
        r.advanceUntil(120, () -> delivered(r, id));
        assertTrue(seqs.size() > 20);
        for (int i = 1; i < seqs.size(); i++) assertEquals(seqs.get(i - 1) + 1, (long) seqs.get(i));
    }
}
