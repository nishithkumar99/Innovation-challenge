package de.smartcare.core.engine;

import de.smartcare.core.ai.DemandForecaster;
import de.smartcare.core.anomaly.Welford;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.routing.Ewma;
import de.smartcare.core.routing.Path;
import de.smartcare.core.routing.RouteConstraints;
import de.smartcare.core.vda.OrderFactory;
import de.smartcare.core.vda.Vda;

import java.util.*;

/**
 * Battery monitoring, automatic charging and charger scheduling.
 * Policy: below {@code critical} a vehicle is never given work; below {@code low} an idle vehicle charges; below
 * {@code opportunisticBelow} it charges when there is no queued work; charging stops at {@code target}, or at
 * {@code minRelease} when work is waiting and no other vehicle is available.
 */
final class EnergyManager {
    private final Context c;
    private final MissionService missions;
    private final DemandForecaster forecast;
    private final AiDecisions decisions;
    private final Ewma pctPerMeter = new Ewma(0.2);
    final Welford consumption = new Welford();           // % per metre, all robots
    final Map<String, Double> lastConsumptionZ = new HashMap<>();
    private int chargeStops;

    EnergyManager(Context c, MissionService missions, DemandForecaster forecast, AiDecisions decisions) {
        this.c = c; this.missions = missions; this.forecast = forecast; this.decisions = decisions;
    }

    double pctPerMeter() { return pctPerMeter.value(c.cfg.energy.defaultPctPerMeter); }

    /** Battery needed to drive {@code meters} plus the safety reserve. */
    double needFor(double meters) { return meters * pctPerMeter() + c.cfg.energy.reservePct; }

    /** Called when a leg completes to learn the real consumption. */
    void observeLeg(Robot r, Mission.Leg leg) {
        double len = c.map.pathLength(leg.path);
        double used = leg.startBattery - r.battery;
        if (len < 5 || r.charging || used < 0) return;
        double perM = used / len;
        if (consumption.count() >= c.cfg.anomaly.minSamples) lastConsumptionZ.put(r.serial, consumption.z(perM));
        pctPerMeter.add(perM);
        consumption.add(perM);
    }

    /**
     * Charging policy, adapted by the learned demand forecast: when many orders are expected soon, idle robots stay ready
     * instead of topping up and charging robots are released early; when it is quiet, robots use the time to charge.
     */
    void tick(int queuedCount) {
        if (c.hold) return;
        long now = c.now();
        boolean useForecast = c.cfg.ai.forecast && forecast.ready();
        double demand = useForecast ? forecast.expectedTotal(now, 10) : 0;
        boolean busySoon = useForecast && demand >= c.cfg.ai.busyOrdersPer10Min;
        for (Robot r : c.fleet.all()) {
            if (!r.online || r.manual || r.paused || r.hasFatalError || r.estop) continue;
            if (r.charging && r.mission == null) {
                boolean full = r.battery >= c.cfg.energy.targetPct;
                if (full) { stop(r); }
                else if (busySoon && r.battery >= c.cfg.energy.minReleasePct) {
                    stop(r);
                    decisions.add(now, "RELEASED_EARLY", r.serial + " left the charger at " + Math.round(r.battery) + " % — about " + fmt(demand) + " orders expected in 10 min");
                }
                continue;
            }
            if (r.mission != null) continue;
            double b = r.battery;
            boolean mustCharge = b < c.cfg.energy.lowPct;
            boolean quiet = queuedCount == 0 && "AUTO".equals(c.mode);
            boolean opportunistic = b < c.cfg.energy.opportunisticBelowPct && quiet && !busySoon;
            if (b < c.cfg.energy.opportunisticBelowPct && b >= c.cfg.energy.lowPct && quiet && busySoon
                    && now - lastKeptLog.getOrDefault(r.serial, 0L) > 120_000L) {
                lastKeptLog.put(r.serial, now);
                decisions.add(now, "KEPT_READY", r.serial + " stays available at " + Math.round(b) + " % — about " + fmt(demand) + " orders expected in 10 min");
            }
            if (mustCharge || opportunistic) startCharging(r);
        }
    }

    private final Map<String, Long> lastKeptLog = new HashMap<>();
    private static String fmt(double v) { return String.valueOf(Math.round(v * 10) / 10.0); }

    private final Map<String, Long> lastStop = new HashMap<>();

    private void stop(Robot r) {
        if (c.now() - lastStop.getOrDefault(r.serial, -60_000L) < 10_000) return;   // one stopCharging per attempt, not one per tick
        lastStop.put(r.serial, c.now());
        c.sendInstant(r, OrderFactory.simple(Vda.ActionType.STOP_CHARGING, "stopc-" + c.now()));
        chargeStops++;
    }

    /** Sends the robot to the closest charger that has a free slot. Returns false if none is available. */
    boolean startCharging(Robot r) {
        MapNode best = null; Path bestPath = null;
        for (MapNode ch : c.map.chargers()) {
            if (c.reservations.nodeLoad(ch.id()) >= ch.capacity() && !r.lastNodeId.equals(ch.id())) continue;
            Optional<Path> p = c.router.shortest(r.lastNodeId, ch.id(), RouteConstraints.NONE);
            if (p.isPresent() && (bestPath == null || p.get().timeS() < bestPath.timeS())) { best = ch; bestPath = p.get(); }
        }
        if (best == null) return false;
        if (r.lastNodeId.equals(best.id()) && r.charging) return true;
        Mission m = new Mission(Mission.Type.CHARGE, null, List.of(new Mission.Leg(bestPath.nodes(), Mission.Role.CHARGE)));
        missions.start(r, m);
        r.chargeStartedMs = c.now();
        return true;
    }

    int chargeStops() { return chargeStops; }
}
