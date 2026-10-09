package de.smartcare.core;

import de.smartcare.core.api.*;
import de.smartcare.core.event.Dto;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/** The intelligence view explains dispatch, energy, traffic and anomaly decisions. */
class IntelTests {
    private static final User STAFF = Rbac.DEMO_USERS.get("u-staff"), OP = Rbac.DEMO_USERS.get("u-op");

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sec(Map<String, Object> m, String k) { return (Map<String, Object>) m.get(k); }

    @Test @DisplayName("Intel needs the full fleet view permission")
    void rbac() {
        Rig r = new Rig(2);
        Api api = new Api(r.core);
        assertEquals(403, assertThrows(ApiException.class, () -> api.intel(STAFF)).status);
        assertNotNull(api.intel(OP));
    }

    @Test @DisplayName("Queue shows priority points, aging and ranked candidate vehicles")
    @SuppressWarnings("unchecked")
    void dispatchView() {
        Rig r = new Rig(2);
        Api api = new Api(r.core);
        r.core.command(new Dto.CommandRequest("FLEET_HOLD", null, Map.of(), null, null), "h", "t");
        api.createTask(OP, new Dto.TaskRequest("WARD", "PH", "WA", "STAT", "Blood", null, "REAL"), null);
        api.createTask(OP, new Dto.TaskRequest("WARD", "LAB", "WA", "ROUTINE", "Sample", null, "REAL"), null);
        r.advance(3);
        var d = sec(api.intel(OP), "dispatch");
        List<Map<String, Object>> q = (List<Map<String, Object>>) d.get("queue");
        assertEquals(2, q.size());
        assertEquals("STAT", q.get(0).get("priority"));
        assertTrue(((Number) q.get(0).get("points")).doubleValue() >= 100);
        List<Map<String, Object>> cands = (List<Map<String, Object>>) q.get(0).get("candidates");
        assertFalse(cands.isEmpty());
        assertTrue(cands.get(0).containsKey("cost"));
        assertEquals(2, ((List<?>) d.get("load")).size());
        assertNotNull(d.get("balanceIndex"));
    }

    @Test @DisplayName("Energy view reports policy, status per robot and chargers")
    @SuppressWarnings("unchecked")
    void energyView() {
        Rig r = new Rig(3);
        Api api = new Api(r.core);
        r.advance(2);
        var e = sec(api.intel(OP), "energy");
        assertEquals(3, ((List<?>) e.get("robots")).size());
        assertFalse(((List<?>) e.get("chargers")).isEmpty());
        assertEquals(100L, ((Number) e.get("availabilityPct")).longValue());
        assertEquals(15.0, ((Number) sec(e, "policy").get("critical")).doubleValue());
    }

    @Test @DisplayName("Traffic and anomaly sections are complete")
    @SuppressWarnings("unchecked")
    void trafficAndAnomalies() {
        Rig r = new Rig(3);
        Api api = new Api(r.core);
        r.advance(5);
        var m = api.intel(OP);
        var t = sec(m, "traffic");
        assertNotNull(t.get("zones"));
        assertNotNull(t.get("deadlocks"));
        assertNotNull(t.get("forecast"));
        var a = sec(m, "anomalies");
        List<Map<String, Object>> det = (List<Map<String, Object>>) a.get("detectors");
        assertTrue(det.size() >= 6);
        assertTrue(det.stream().allMatch(x -> x.get("state") != null));
    }
}
