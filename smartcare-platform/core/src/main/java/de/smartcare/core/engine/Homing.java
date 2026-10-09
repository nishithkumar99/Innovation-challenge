package de.smartcare.core.engine;

import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.routing.RouteConstraints;

import java.util.*;

/**
 * Keeps vehicles out of each other's way when they have nothing to do.
 *
 * <p><b>Homing.</b> A vehicle that is idle but does not stand on a node (a cancelled order leaves it between two nodes) and
 * blocks a corridor is sent to the closest free home node, normally a charging station.
 *
 * <p><b>Parking.</b> A vehicle that stays idle on a delivery station would block the corridor beside it (and the stations
 * of the organizers' map lie on their hallways), so after a while it goes to a free home node, unless the demand forecast
 * wants it where it is.
 */
final class Homing {
    private final Context c;
    private final MissionService missions;
    private final Map<String, Long> lastTry = new HashMap<>();
    private int sent;

    private final Positioner positioner;

    Homing(Context c, MissionService missions, Positioner positioner) { this.c = c; this.missions = missions; this.positioner = positioner; }

    int sent() { return sent; }

    void tick(int queued) {
        if (!c.cfg.core.autoHome || c.hold || !"AUTO".equals(c.mode)) return;
        long now = c.now();
        List<String> homes = new ArrayList<>();
        for (String id : c.cfg.core.homeNodes.split(",")) if (!id.isBlank() && c.map.node(id.trim()) != null) homes.add(id.trim());
        if (homes.isEmpty()) return;
        // the vehicle closest to its node first: in a row of vehicles, the one at the front can leave
        List<Robot> candidates = new ArrayList<>();
        for (Robot r : c.fleet.all()) {
            if (!r.online || r.manual || r.paused || r.latched || r.hasFatalError || r.estop || r.busy() || r.state == null || r.lastNodeId == null) continue;
            MapNode n = c.map.node(r.lastNodeId);
            if (n == null) continue;
            if (now - lastTry.getOrDefault(r.serial, -60_000L) < 20_000) continue;
            boolean offNode = Math.hypot(n.x() - r.x, n.y() - r.y) > c.cfg.core.homeToleranceM;
            if (offNode) { if (now - r.idleSinceMs < 2_000 || !inACorridor(r)) continue; }
            else {
                double after = c.cfg.core.parkAfterS;
                if (after <= 0 || queued > 0 || homes.contains(r.lastNodeId) || now - r.idleSinceMs < after * 1000L) continue;
                if (fleetBusyOrBlocked()) continue;               // parking is optional and must never add traffic to a busy network
                if (positioner.isHot(r.lastNodeId) || r.charging) continue;
            }
            candidates.add(r);
        }
        candidates.sort(Comparator.comparingDouble(r -> { MapNode n = c.map.node(r.lastNodeId); return Math.hypot(n.x() - r.x, n.y() - r.y); }));
        for (Robot r : candidates) {
            lastTry.put(r.serial, now);
            String best = null; double bestT = Double.MAX_VALUE;
            for (String h : homes) {
                if (c.reservations.nodeLoad(h) > 0 || targeted(h)) continue;
                var p = c.router.shortest(r.lastNodeId, h, RouteConstraints.NONE);
                if (p.isPresent() && p.get().timeS() < bestT) { bestT = p.get().timeS(); best = h; }
            }
            if (best == null) continue;
            var m = missions.planSingle(r, best, Mission.Type.GOTO, Mission.Role.GOTO);
            if (m.isEmpty()) continue;
            missions.start(r, m.get());
            sent++;
        }
    }

    /**
     * Off-node vehicles only have to be moved when they stand in a corridor, i.e. within collision distance of an edge (after a
     * cancelled order). A vehicle parked beside the network, like the simulator's start-up row, is out of the way and is simply
     * used by the dispatcher when its turn comes.
     */
    private boolean inACorridor(Robot r) {
        double clearance = Math.max(c.cfg.traffic.physicalClearanceM, 1.0);
        for (var e : c.map.edges()) {
            MapNode a = c.map.node(e.a()), b = c.map.node(e.b());
            double dx = b.x() - a.x(), dy = b.y() - a.y(), l2 = dx * dx + dy * dy;
            double t = l2 == 0 ? 0 : Math.max(0, Math.min(1, ((r.x - a.x()) * dx + (r.y - a.y()) * dy) / l2));
            if (Math.hypot(r.x - (a.x() + t * dx), r.y - (a.y() + t * dy)) < clearance) return true;
        }
        return false;
    }

    /** Some vehicle is waiting for a free way, or another optional trip is under way. */
    private boolean fleetBusyOrBlocked() {
        for (Robot o : c.fleet.all()) {
            if (o.waitingOn != null) return true;
            if (o.mission != null && !o.mission.finished() && o.mission.taskId == null && o.mission.type == Mission.Type.GOTO) return true;
        }
        return false;
    }

    private boolean targeted(String node) {
        for (Robot o : c.fleet.all()) if (o.mission != null && !o.mission.finished() && node.equals(o.mission.legs.get(o.mission.legs.size() - 1).last())) return true;
        return false;
    }
}
