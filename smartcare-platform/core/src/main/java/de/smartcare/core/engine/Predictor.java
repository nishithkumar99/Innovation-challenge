package de.smartcare.core.engine;

import de.smartcare.core.event.Dto;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.model.MapEdge;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.task.Task;

import java.util.*;

/**
 * Congestion forecast for +5/+15/+30 minutes. Every active mission is rolled forward along its remaining route using
 * the learned edge times; queued tasks are added with a reduced weight at the time they are likely to start.
 * Edge utilisation = expected robot-seconds inside the window / window length. A value ≥ threshold means the corridor is
 * expected to carry about one robot at all times (single-lane edge: queuing starts).
 */
final class Predictor {
    private static final int[] HORIZONS = {5, 15, 30};
    private final Context c;
    private final Dispatcher dispatcher;
    private Map<String, Double> util5 = Map.of();
    private List<Dto.Hotspot> last = List.of();

    Predictor(Context c, Dispatcher d) { this.c = c; this.dispatcher = d; }

    double utilNow(String edgeId) { return util5.getOrDefault(edgeId, 0.0); }
    List<Dto.Hotspot> last() { return last; }

    List<Dto.Hotspot> compute() {
        // passes: edge -> list of [enter, exit, weight] in seconds from now
        Map<String, List<double[]>> passes = new HashMap<>();
        for (Robot r : c.fleet.all()) {
            Mission m = r.mission;
            if (m == null || m.finished() || !r.online) continue;
            double t = 0;
            for (int li = m.legIdx; li < m.legs.size(); li++) {
                Mission.Leg l = m.legs.get(li);
                int from = li == m.legIdx ? Math.max(0, l.reachedIdx) : 0;
                for (int k = from; k + 1 < l.path.size(); k++) {
                    MapEdge e = c.map.edgeBetween(l.path.get(k), l.path.get(k + 1));
                    double dt = c.router.edgeTime(e);
                    passes.computeIfAbsent(e.id(), x -> new ArrayList<>()).add(new double[]{t, t + dt, 1.0});
                    t += dt;
                }
                if (l.actionId != null) t += c.cfg.sim.actionSeconds;
            }
        }
        int pos = 0;
        long fleetSize = Math.max(1, c.fleet.all().stream().filter(x -> x.online && !x.manual).count());
        for (Task q : dispatcher.queue()) {
            // the k-th queued task starts roughly when the k-th vehicle becomes free (one work cycle ≈ 60 s per vehicle)
            double start = 20.0 + 60.0 * (pos++ / fleetSize);
            var p = c.router.shortestIgnoringTraffic(q.from, q.to);
            if (p.isEmpty()) continue;
            double t = start;
            for (int k = 0; k + 1 < p.get().nodes().size(); k++) {
                MapEdge e = c.map.edgeBetween(p.get().nodes().get(k), p.get().nodes().get(k + 1));
                double dt = c.router.edgeTime(e);
                passes.computeIfAbsent(e.id(), x -> new ArrayList<>()).add(new double[]{t, t + dt, 0.6});
                t += dt;
            }
        }
        List<Dto.Hotspot> out = new ArrayList<>();
        Map<String, Double> u5 = new HashMap<>();
        double threshold = Math.max(0.1, c.cfg.traffic.predictionLoadThreshold);
        for (int h : HORIZONS) {
            double w0 = Math.max(0, h * 60 - 120), w1 = h * 60 + 120, len = w1 - w0;
            for (var en : passes.entrySet()) {
                double sum = 0;
                for (double[] p : en.getValue()) sum += Math.max(0, Math.min(p[1], w1) - Math.max(p[0], w0)) * p[2];
                double util = sum / len;
                if (h == 5) u5.put(en.getKey(), util);
                double sev = Math.min(1, util / threshold);
                if (sev < 0.35) continue;
                MapEdge e = c.map.edge(en.getKey());
                MapNode a = c.map.node(e.a()), b = c.map.node(e.b());
                double conf = (h == 5 ? 0.9 : h == 15 ? 0.75 : 0.6);
                out.add(new Dto.Hotspot("hs-" + e.id() + "-" + h, e.id(), new Dto.Vec((a.x() + b.x()) / 2, (a.y() + b.y()) / 2),
                        2.5 + 2.5 * sev, h, round(sev), conf));
            }
        }
        util5 = u5;
        last = out;
        return out;
    }

    private static double round(double v) { return Math.round(v * 100) / 100.0; }
}
