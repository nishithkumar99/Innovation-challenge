package de.smartcare.core.engine;

import de.smartcare.core.ai.DemandForecaster;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.routing.RouteConstraints;

import java.util.*;

/**
 * Uses the demand forecast to wait where orders will appear: when no order is queued, one idle healthy robot is parked
 * at the pickup station with the highest expected demand, so the next order starts with a short (or zero) approach.
 */
final class Positioner {
    private final Context c;
    private final MissionService missions;
    private final DemandForecaster forecast;
    private final AiDecisions decisions;
    private final Map<String, Long> lastMove = new HashMap<>();
    private long lastRun;
    private int moves;

    Positioner(Context c, MissionService m, DemandForecaster f, AiDecisions d) { this.c = c; this.missions = m; this.forecast = f; this.decisions = d; }

    int moves() { return moves; }

    private Set<String> hot = Set.of();
    /** True if the forecast expects orders at this station soon, so an idle vehicle there is waiting on purpose. */
    boolean isHot(String station) { return hot.contains(station); }

    void tick(int queued) {
        var a = c.cfg.ai;
        long now = c.now();
        if (!a.forecast || !a.prePosition || c.hold || !"AUTO".equals(c.mode) || queued > 0 || !forecast.ready()) return;
        if (now - lastRun < 5_000) return;
        lastRun = now;

        // stations ranked by expected demand
        List<Map.Entry<String, Double>> ranked = new ArrayList<>(forecast.perStation(now, 10).entrySet());
        ranked.sort((x, y) -> Double.compare(y.getValue(), x.getValue()));
        Set<String> h = new HashSet<>();
        for (var e : ranked) if (e.getValue() >= a.prePositionMinOrders) h.add(e.getKey());
        hot = h;
        for (var e : ranked) {
            if (e.getValue() < a.prePositionMinOrders) break;
            String station = e.getKey();
            MapNode node = c.map.node(station);
            if (node == null) continue;
            if (covered(station)) continue;
            Robot best = null; double bestT = Double.MAX_VALUE;
            for (Robot r : c.fleet.all()) {
                if (!r.online || r.manual || r.paused || r.hasFatalError || r.estop || r.charging || r.busy() || r.state == null || r.lastNodeId == null) continue;
                if (r.battery < a.prePositionMinBattery) continue;
                if (now - lastMove.getOrDefault(r.serial, 0L) < a.prePositionCooldownS * 1000L) continue;
                if (isParkedAtHotStation(r, ranked)) continue;
                var p = c.router.shortest(r.lastNodeId, station, RouteConstraints.NONE);
                if (p.isPresent() && p.get().timeS() < bestT) { bestT = p.get().timeS(); best = r; }
            }
            if (best == null) continue;
            var m = missions.planSingle(best, station, Mission.Type.GOTO, Mission.Role.GOTO);
            if (m.isEmpty()) continue;
            missions.start(best, m.get());
            lastMove.put(best.serial, now);
            moves++;
            decisions.add(now, "PRE_POSITION", best.serial + " sent to " + node.name() + " — about " + Math.round(e.getValue() * 10) / 10.0 + " orders expected in 10 min");
            return;                                   // one move per cycle keeps traffic calm
        }
    }

    /** A robot already stands at, or is driving to, this station. */
    private boolean covered(String station) {
        for (Robot r : c.fleet.all()) {
            if (!r.online || r.manual) continue;
            if (r.mission == null && station.equals(r.lastNodeId)) return true;
            if (r.mission != null && !r.mission.finished() && r.mission.type == Mission.Type.GOTO && station.equals(r.mission.legs.get(r.mission.legs.size() - 1).last())) return true;
        }
        return false;
    }

    private boolean isParkedAtHotStation(Robot r, List<Map.Entry<String, Double>> ranked) {
        for (var e : ranked) if (e.getValue() >= c.cfg.ai.prePositionMinOrders && e.getKey().equals(r.lastNodeId)) return true;
        return false;
    }
}
