package de.smartcare.core.engine;

import de.smartcare.core.dispatch.Hungarian;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.routing.Path;
import de.smartcare.core.routing.RouteConstraints;
import de.smartcare.core.task.Task;

import java.util.*;

/**
 * Intelligent task distribution: priority + aging order the queue, the cost of a (task, vehicle) pair combines travel
 * time to the pickup (with live congestion), recent workload of the vehicle (load balancing), battery level and route
 * congestion; the batch is solved optimally with the Hungarian algorithm.
 */
final class Dispatcher {
    private static final double FORBIDDEN = 1e9;
    private final Context c;
    private final MissionService missions;
    private final EnergyManager energy;
    private int assignments;
    private final List<String> lastDecision = new ArrayList<>();

    Dispatcher(Context c, MissionService missions, EnergyManager energy) { this.c = c; this.missions = missions; this.energy = energy; }

    int assignments() { return assignments; }
    List<String> lastDecision() { return List.copyOf(lastDecision); }

    /** Effective priority points: STAT 100, URGENT 50, ROUTINE 20 plus aging. */
    double points(Task t) {
        double base = switch (t.priority) { case STAT -> 100; case URGENT -> 50; case ROUTINE -> 20; };
        double ageMin = (c.now() - t.createdAt) / 60000.0;
        return base + Math.min(c.cfg.dispatch.agingCap, ageMin * c.cfg.dispatch.agingPerMin);
    }

    List<Task> queue() {
        List<Task> q = new ArrayList<>();
        for (Task t : c.tasks.values()) if (t.isQueued()) q.add(t);
        q.sort(Comparator.comparingDouble(this::points).reversed().thenComparingLong(t -> t.createdAt));
        return q;
    }

    void tick() {
        if (c.hold) return;
        List<Task> q = queue();
        if (q.isEmpty()) return;
        // eligible robots: free, healthy, or charging with enough battery to be released
        List<Robot> robots = new ArrayList<>();
        for (Robot r : c.fleet.all()) {
            if (!r.online || r.manual || r.paused || r.hasFatalError || r.estop || r.busy()) continue;
            if (r.state == null || r.lastNodeId == null) continue;
            if (r.charging && r.battery < c.cfg.energy.minReleasePct) continue;
            if (r.battery <= c.cfg.energy.criticalPct) continue;
            robots.add(r);
        }
        if (robots.isEmpty()) return;
        long cutoff = c.now() - (long) (c.cfg.dispatch.recentWindowS * 1000);
        for (Robot r : robots) { r.completions.removeIf(t -> t < cutoff); r.tasksRecent = r.completions.size(); }

        List<Task> batch = q.subList(0, Math.min(q.size(), c.cfg.dispatch.maxBatch));
        if (!c.cfg.dispatch.hungarian) { greedy(batch, robots); return; }

        // Hungarian needs rows <= cols: transpose when there are more tasks than robots
        double[][] cost = new double[batch.size()][robots.size()];
        for (int i = 0; i < batch.size(); i++) for (int j = 0; j < robots.size(); j++) cost[i][j] = cost(batch.get(i), robots.get(j));
        int[] pick;
        boolean transposed = batch.size() > robots.size();
        if (!transposed) pick = Hungarian.solve(cost);
        else {
            double[][] t = new double[robots.size()][batch.size()];
            for (int i = 0; i < batch.size(); i++) for (int j = 0; j < robots.size(); j++) t[j][i] = cost[i][j];
            int[] rj = Hungarian.solve(t);       // robot j -> task index
            pick = new int[batch.size()];
            Arrays.fill(pick, -1);
            for (int j = 0; j < rj.length; j++) pick[rj[j]] = j;
        }
        lastDecision.clear();
        // assign in priority order so that STAT tasks get their robots first if a plan turns out to be infeasible
        for (int i = 0; i < batch.size(); i++) {
            if (pick[i] < 0 || cost[i][pick[i]] >= FORBIDDEN) continue;
            assign(batch.get(i), robots.get(pick[i]), cost[i][pick[i]]);
        }
    }

    private void greedy(List<Task> batch, List<Robot> robots) {
        Set<Robot> used = new HashSet<>();
        for (Task t : batch) {
            Robot best = null; double bc = FORBIDDEN;
            for (Robot r : robots) { if (used.contains(r)) continue; double v = cost(t, r); if (v < bc) { bc = v; best = r; } }
            if (best != null) { used.add(best); assign(t, best, bc); }
        }
    }

    /** Cost in "seconds, divided by priority weight" so that urgent work wins scarce vehicles. */
    double cost(Task t, Robot r) {
        if (t.excludedRobots.contains(r.serial)) return FORBIDDEN;
        Optional<Path> toPick = c.router.shortest(r.lastNodeId, t.from, RouteConstraints.NONE);
        Optional<Path> carry = c.router.shortestIgnoringTraffic(t.from, t.to);
        if (toPick.isEmpty() || carry.isEmpty()) return FORBIDDEN;
        // energy feasibility: pickup + delivery + the trip to the nearest charger afterwards
        double meters = toPick.get().lengthM() + carry.get().lengthM() + nearestChargerMeters(t.to);
        if (r.battery < energy.needFor(meters) + c.cfg.energy.criticalPct) return FORBIDDEN;
        double congestion = 0;
        for (int i = 0; i + 1 < toPick.get().nodes().size(); i++) {
            var e = c.map.edgeBetween(toPick.get().nodes().get(i), toPick.get().nodes().get(i + 1));
            congestion += c.reservations.edgeLoad(e.id());
        }
        double raw = toPick.get().timeS() + offNodeSeconds(r)
                + c.cfg.dispatch.weightLoadBalance * r.tasksRecent
                + c.cfg.dispatch.weightBattery * (100 - r.battery)
                + c.cfg.dispatch.weightCongestion * congestion
                + (r.charging ? 15 : 0);
        double weight = points(t) / 20.0;
        return raw / weight;
    }

    /** A vehicle that does not stand exactly on its node (e.g. right after start-up) first has to drive to it. */
    private double offNodeSeconds(Robot r) {
        var n = c.map.node(r.lastNodeId);
        return n == null ? 0 : Math.hypot(n.x() - r.x, n.y() - r.y) / Math.max(0.1, c.cfg.sim.speedMps);
    }

    private double nearestChargerMeters(String from) {
        double best = 0;
        boolean any = false;
        for (var ch : c.map.chargers()) {
            var p = c.router.shortestIgnoringTraffic(from, ch.id());
            if (p.isPresent() && (!any || p.get().lengthM() < best)) { best = p.get().lengthM(); any = true; }
        }
        return best;
    }

    private void assign(Task t, Robot r, double cost) {
        Optional<Mission> m = missions.planTask(r, t);
        if (m.isEmpty()) return;
        t.robotId = r.serial;
        t.status = Task.Status.ASSIGNED;
        t.assignedAt = c.now();
        t.touch();
        assignments++;
        lastDecision.add(t.id + " -> " + r.serial + " (cost " + Math.round(cost * 10) / 10.0 + ")");
        missions.start(r, m.get());
        c.bus.publish("tasks.events", List.of(TaskMapper.dto(t)));
    }
}
