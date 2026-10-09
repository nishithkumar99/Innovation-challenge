package de.smartcare.core;

import de.smartcare.core.api.*;
import de.smartcare.core.event.Dto;
import de.smartcare.core.event.Envelope;
import de.smartcare.core.task.Task;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/** Authorisation, idempotency and per-user data scoping of the application service. */
class ApiTests {
    private static final User STAFF = Rbac.DEMO_USERS.get("u-staff"), LEAD = Rbac.DEMO_USERS.get("u-lead"), OP = Rbac.DEMO_USERS.get("u-op"), MGR = Rbac.DEMO_USERS.get("u-mgr");

    private static Dto.TaskRequest req(String from, String to) { return new Dto.TaskRequest("WARD", from, to, "ROUTINE", "Blood sample", null, "REAL"); }

    @Test @DisplayName("Dev bearer tokens resolve to personas")
    void tokens() {
        assertEquals("u-op", Rbac.fromDevToken("Bearer mock.u-op").id());
        assertNull(Rbac.fromDevToken("Bearer nonsense"));
        assertNull(Rbac.fromDevToken(null));
    }

    @Test @DisplayName("Task creation is idempotent per user and key")
    void idempotent() {
        Rig r = Rig.onSimulatorMap(1);
        Api api = new Api(r.core);
        String a = api.createTask(STAFF, req("Ward1_Hallway", "Pharmacy_Hallway"), "key-1");
        String b = api.createTask(STAFF, req("Ward1_Hallway", "Pharmacy_Hallway"), "key-1");
        assertEquals(a, b);
        assertNotEquals(a, api.createTask(STAFF, req("Ward1_Hallway", "Pharmacy_Hallway"), "key-2"));
        assertEquals(2, r.core.tasksSnapshot().size());
    }

    @Test @DisplayName("Permissions are enforced")
    void permissions() {
        Rig r = Rig.onSimulatorMap(1);
        Api api = new Api(r.core);
        String id = api.createTask(OP, req("Pharmacy_Hallway", "Ward1_Hallway"), null);
        assertEquals(403, assertThrows(ApiException.class, () -> api.command(STAFF, new Dto.CommandRequest("PAUSE", "AMR-1", Map.of(), null, null), "c")).status);
        assertEquals(403, assertThrows(ApiException.class, () -> api.command(OP, new Dto.CommandRequest("FLEET_HOLD", null, Map.of(), null, null), "c")).status);
        api.command(MGR, new Dto.CommandRequest("FLEET_HOLD", null, Map.of(), null, null), "c");
        api.command(MGR, new Dto.CommandRequest("FLEET_RESUME", null, Map.of(), null, null), "c");
        assertEquals(403, assertThrows(ApiException.class, () -> api.command(STAFF, new Dto.CommandRequest("CANCEL_TASK", id, Map.of(), null, null), "c")).status);
        assertEquals(401, assertThrows(ApiException.class, () -> api.snapshot(null)).status);
        assertEquals(403, assertThrows(ApiException.class, () -> api.applyInsight(STAFF, "x", "c")).status);
        assertEquals(400, assertThrows(ApiException.class, () -> api.createTask(STAFF, req("Ward1_Hallway", "Ward1_Hallway"), null)).status);
        assertEquals(403, assertThrows(ApiException.class, () -> api.createTask(STAFF, new Dto.TaskRequest("WARD", "Ward1_Hallway", "Pharmacy_Hallway", "ROUTINE", "x", null, "SIMULATED"), null)).status);
    }

    @Test @DisplayName("Staff can cancel their own request only")
    void ownCancel() {
        Rig r = Rig.onSimulatorMap(1);
        Api api = new Api(r.core);
        r.core.command(new Dto.CommandRequest("FLEET_HOLD", null, Map.of(), null, null), "h", "u");
        String mine = api.createTask(STAFF, req("Ward1_Hallway", "Pharmacy_Hallway"), null);
        String other = api.createTask(OP, req("Pharmacy_Hallway", "Ward1_Hallway"), null);
        assertEquals(403, assertThrows(ApiException.class, () -> api.command(STAFF, new Dto.CommandRequest("CANCEL_TASK", other, Map.of(), null, null), "c1")).status);
        api.command(STAFF, new Dto.CommandRequest("CANCEL_TASK", mine, Map.of(), null, null), "c2");
        assertEquals(Task.Status.CANCELLED, r.core.task(mine).status);
    }

    @Test @DisplayName("Staff see only their own tasks and the robot serving them")
    void scoping() {
        Rig r = new Rig("/map/hospital.json", 2, c -> { c.traffic.stationCapacityDefault = 1; c.sim.speedMps = 1.0; c.sim.startNodes = "Ward1_Hallway,Pharmacy_Hallway"; });
        Api api = new Api(r.core);
        String mine = api.createTask(STAFF, req("Ward1_Hallway", "Pharmacy_Hallway"), null);
        String other = api.createTask(OP, req("Pharmacy_Hallway", "Ward2_Hallway"), null);
        r.advance(3);
        Dto.Snapshot staff = api.snapshot(STAFF);
        assertEquals(1, staff.tasks().size());
        assertEquals(mine, staff.tasks().get(0).id());
        assertEquals(1, staff.robots().size());
        assertTrue(staff.zones().isEmpty());
        assertTrue(staff.predictions().isEmpty());
        Dto.Snapshot ops = api.snapshot(OP);
        assertEquals(2, ops.tasks().size());
        assertEquals(2, ops.robots().size());
        assertFalse(ops.zones().isEmpty());

        // stream filtering keeps seq but hides payloads
        Scope sc = new Scope(STAFF);
        sc.filter(api.snapshot(OP));
        Envelope kpi = new Envelope("kpi.live", 5, 0, new Object());
        assertNull(sc.filter(kpi).payload());
        assertEquals(5, sc.filter(kpi).seq());
        Envelope tasks = new Envelope("tasks.events", 6, 0, List.copyOf(r.core.tasksSnapshot()));
        assertEquals(1, ((List<?>) sc.filter(tasks).payload()).size());
    }

    @Test @DisplayName("Department leads also see tasks of their department")
    void deptScope() {
        Rig r = Rig.onSimulatorMap(1);
        Api api = new Api(r.core);
        api.createTask(OP, req("Pharmacy_Hallway", "Ward2_Hallway"), null);        // delivered to the lead's ward B
        api.createTask(OP, req("Pharmacy_Hallway", "Ward1_Hallway"), null);
        assertEquals(1, api.snapshot(LEAD).tasks().size());
    }

    @Test @DisplayName("WebSocket tickets are single use")
    void tickets() {
        Api api = new Api(Rig.onSimulatorMap(1).core);
        String t = api.issueTicket(OP);
        assertEquals("u-op", api.redeemTicket(t).id());
        assertNull(api.redeemTicket(t));
        assertNull(api.redeemTicket("bogus"));
    }
}
