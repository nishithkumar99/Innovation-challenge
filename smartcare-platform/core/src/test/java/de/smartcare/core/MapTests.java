package de.smartcare.core;

import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.model.NodeKind;
import de.smartcare.core.task.Task;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/** The shipped map is the organizers' route_nodes.json (simulator format); these tests guard how it is read. */
class MapTests {
    private static HospitalMap real() throws Exception {
        try (var in = MapTests.class.getResourceAsStream("/map/hospital.json")) { return HospitalMap.load(in, 1, 65, 40); }
    }

    @Test @DisplayName("The simulator map loads: 23 nodes, 4 chargers, names and kinds derived from the ids")
    void loads() throws Exception {
        HospitalMap m = real();
        assertEquals(23, m.nodes().size());
        assertEquals(4, m.chargers().size());
        assertEquals(65.0, m.width());
        assertEquals(40.0, m.height());
        assertEquals(NodeKind.PHARMACY, m.node("Pharmacy_Hallway").kind());
        assertEquals(NodeKind.WARD, m.node("Ward2_Hallway").kind());
        assertEquals(NodeKind.OR, m.node("OR_1_Hallway").kind());
        assertEquals(NodeKind.CHECKIN, m.node("Check-In_Hallway").kind());
        assertEquals(NodeKind.JUNCTION, m.node("Waypoint_Hallway_North").kind());
        assertEquals("Charging Station 1", m.node("Charging_Station1_Hallway").name());
        assertEquals("Ward 2", m.node("Ward2_Hallway").name());
        assertEquals("Waypoint North", m.node("Waypoint_Hallway_North").name());
    }

    @Test @DisplayName("Edges need both nodes to list each other; duplicates in the file are ignored; the map is connected")
    void edges() throws Exception {
        HospitalMap m = real();
        assertNotNull(m.edgeBetween("Charging_Station3_Hallway", "Waypoint_Hallway_North"));
        assertNotNull(m.edgeBetween("Waste_Hallway", "Kitchen_Hallway_North"));
        assertNull(m.edgeBetween("Ward2_Hallway", "Pharmacy_Hallway"));
        Deque<String> q2 = new ArrayDeque<>(List.of("Pharmacy_Hallway"));
        Set<String> seen = new HashSet<>(q2);
        while (!q2.isEmpty()) { String n = q2.poll(); for (var e : m.edgesOf(n)) { String o = e.other(n); if (seen.add(o)) q2.add(o); } }
        assertEquals(m.nodes().size(), seen.size(), "every node must be reachable");
        m.edges().forEach(e -> assertTrue(e.length() > 0));
    }

    @Test @DisplayName("A vehicle standing next to a node is snapped to it; far away it is not")
    void snap() throws Exception {
        HospitalMap m = real();
        assertEquals("Waypoint_Hallway_Southwest", m.nearest(14, 11, 3).orElseThrow().id());
        assertTrue(m.nearest(0, 0, 3).isEmpty());
    }

    @Test @DisplayName("A task is delivered on the simulator map")
    void delivery() {
        Rig r = Rig.onSimulatorMap(2);
        String id = r.core.createTask("PHARMACY", "Pharmacy_Hallway", "Ward2_Hallway", "URGENT", "Medication", null, "REAL", "u1", "Tester");
        assertTrue(r.advanceUntil(400, () -> r.core.task(id).status == Task.Status.DELIVERED), "status " + r.core.task(id).status);
    }

    @Test @DisplayName("With the action names left blank the order carries no actions and the task still completes")
    void noActions() {
        Rig r = new Rig("/map/hospital.json", 2, c -> { c.traffic.stationCapacityDefault = 1; c.sim.speedMps = 1.0; c.mqtt.pickAction = ""; c.mqtt.dropAction = ""; c.mqtt.chargeAction = ""; });
        String id = r.core.createTask("PHARMACY", "Kitchen_Hallway_West", "Ward1_Hallway", "ROUTINE", "Meals", null, "REAL", "u1", "Tester");
        assertTrue(r.advanceUntil(500, () -> r.core.task(id).status == Task.Status.DELIVERED), "status " + r.core.task(id).status);
    }
}
