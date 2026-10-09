package de.smartcare.core;

import de.smartcare.core.ai.DemandForecaster;
import de.smartcare.core.api.*;
import de.smartcare.core.event.Dto;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/** Learned demand forecast, forecast-driven charging and positioning, additional nurse accounts. */
class AiTests {
    @Test @DisplayName("Forecaster learns a steady arrival rate and reports its error")
    void learns() {
        DemandForecaster f = new DemandForecaster(60, 3);
        long t = 0;
        assertFalse(f.ready());
        for (int minute = 0; minute < 12; minute++) {
            for (int k = 0; k < 3; k++) f.record("PH", t + k * 1000L);
            t += 60_000;
            f.advance(t);
        }
        assertTrue(f.ready());
        assertEquals(30.0, f.expected("PH", t, 10), 3.0);           // 3 per minute → ~30 in 10 minutes
        assertEquals(0.0, f.expected("LAB", t, 10), 1e-9);
        assertTrue(f.mae() <= f.naiveMae() + 1e-9);
    }

    @Test @DisplayName("Forecaster adapts when demand stops")
    void decays() {
        DemandForecaster f = new DemandForecaster(60, 3);
        long t = 0;
        for (int i = 0; i < 8; i++) { for (int k = 0; k < 4; k++) f.record("PH", t); t += 60_000; f.advance(t); }
        double busy = f.expectedTotal(t, 10);
        for (int i = 0; i < 12; i++) { t += 60_000; f.advance(t); }
        assertTrue(f.expectedTotal(t, 10) < busy / 2);
    }

    private static void burst(Rig r, Api api, User op, String from, String to, int perMinute, int minutes) {
        for (int m = 0; m < minutes; m++) {
            for (int k = 0; k < perMinute; k++) api.createTask(op, new Dto.TaskRequest("WARD", from, to, "ROUTINE", "Sample", null, "REAL"), null);
            r.advance(60);
        }
    }

    @Test @DisplayName("Idle robot is parked at the station where orders are expected")
    @SuppressWarnings("unchecked")
    void prePositions() {
        Rig r = new Rig(3, c -> { c.ai.minBuckets = 3; c.ai.prePositionMinOrders = 0.5; });
        Api api = new Api(r.core);
        User op = Rbac.DEMO_USERS.get("u-op");
        burst(r, api, op, "LAB", "WA", 1, 6);
        r.advance(120);
        var f = (Map<String, Object>) api.intel(op).get("forecast");
        assertEquals(Boolean.TRUE, f.get("ready"));
        var counters = (Map<String, Object>) f.get("counters");
        var dec = (List<Map<String, Object>>) f.get("decisions");
        assertTrue(((Number) counters.get("PRE_POSITION")).intValue() >= 1, "expected a pre-positioning move, decisions: " + dec);
        assertTrue(dec.stream().anyMatch(x -> String.valueOf(x.get("text")).contains("Laboratory")), String.valueOf(dec));
    }

    @Test @DisplayName("High expected demand keeps idle robots available instead of topping up")
    @SuppressWarnings("unchecked")
    void keepsReady() {
        Rig r = new Rig(2, c -> { c.ai.minBuckets = 3; c.ai.busyOrdersPer10Min = 2; c.ai.prePosition = false; });
        Api api = new Api(r.core);
        User op = Rbac.DEMO_USERS.get("u-op");
        burst(r, api, op, "PH", "WA", 1, 5);
        r.advanceUntil(120, () -> r.core.tasksSnapshot().stream().allMatch(t -> t.status().equals("DELIVERED")));
        r.sim.setBattery("AMR-1", 50);                               // queue empty, demand still expected
        r.advance(5);
        var f = (Map<String, Object>) api.intel(op).get("forecast");
        assertEquals("HIGH", f.get("demandLevel"));
        var d = (List<Map<String, Object>>) f.get("decisions");
        assertTrue(d.stream().anyMatch(x -> "KEPT_READY".equals(x.get("type"))), "robot below 60 % should stay ready: " + d);
    }

    @Test @DisplayName("Additional nurse accounts are limited to their own department")
    void nurses() {
        for (String id : List.of("u-staff", "u-staff2", "u-staff3", "u-staff4")) {
            User u = Rbac.DEMO_USERS.get(id);
            assertNotNull(u, id);
            assertEquals("STAFF", u.role());
            assertTrue(u.can("task:create"));
            assertFalse(u.can("fleet:view:full"));
        }
        assertEquals("Ward2_Hallway", Rbac.DEMO_USERS.get("u-staff2").department());
        assertEquals("OR_2_Hallway", Rbac.DEMO_USERS.get("u-staff4").department());
        assertEquals("u-staff3", Rbac.fromDevToken("Bearer mock.u-staff3").id());
        Rig r = Rig.onSimulatorMap(1);
        Api api = new Api(r.core);
        String id = api.createTask(Rbac.DEMO_USERS.get("u-staff2"), new Dto.TaskRequest("WARD", "Ward2_Hallway", "Pharmacy_Hallway", "ROUTINE", "Blood", null, "REAL"), null);
        assertEquals(1, api.snapshot(Rbac.DEMO_USERS.get("u-staff2")).tasks().size());
        assertEquals(0, api.snapshot(Rbac.DEMO_USERS.get("u-staff3")).tasks().size());
        assertNotNull(id);
    }
}
