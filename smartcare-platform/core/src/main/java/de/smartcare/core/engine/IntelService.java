package de.smartcare.core.engine;

import de.smartcare.core.ai.DemandForecaster;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.insight.Insight;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.model.MapEdge;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.model.Zone;
import de.smartcare.core.task.Task;

import java.util.*;
import java.util.function.Function;

/**
 * Read-only "why did the AI do that" view for the operator UI (GET /api/intel). It only explains decisions that the
 * dispatcher, energy manager, traffic controller and anomaly detector have already taken; it never changes state.
 * Everything is organised along the four focus areas: dispatch, energy, traffic, anomalies.
 * Must be called while holding the CoreEngine lock.
 */
final class IntelService {
    private static final int HISTORY = 180;               // one sample per second → 3 minutes
    private final Context c;
    private final Dispatcher dispatcher;
    private final EnergyManager energy;
    private final TrafficController traffic;
    private final Predictor predictor;
    private final AnomalyDetector anomalies;
    private final Function<Robot, String> status;
    private final DemandForecaster forecaster;
    private final AiDecisions decisions;
    private final Positioner positioner;
    private final Deque<double[]> history = new ArrayDeque<>();   // [ts, availability%, avgBattery, queue, waiting, congestion%]

    IntelService(Context c, Dispatcher d, EnergyManager e, TrafficController t, Predictor p, AnomalyDetector a, Function<Robot, String> status,
                  DemandForecaster f, AiDecisions decisions, Positioner positioner) {
        this.c = c; this.dispatcher = d; this.energy = e; this.traffic = t; this.predictor = p; this.anomalies = a; this.status = status;
        this.forecaster = f; this.decisions = decisions; this.positioner = positioner;
    }

    /** Called once per second by the core loop. */
    void sample() {
        List<Robot> all = new ArrayList<>(c.fleet.all());
        if (all.isEmpty()) return;
        long available = all.stream().filter(r -> r.available(c.cfg.energy.criticalPct)).count();
        double avgBat = all.stream().filter(r -> r.online).mapToDouble(r -> r.battery).average().orElse(0);
        long waiting = all.stream().filter(r -> r.waitingOn != null).count();
        double thr = Math.max(0.1, c.cfg.traffic.predictionLoadThreshold);
        double cong = predictor.last().stream().filter(h -> h.horizonMin() == 5).mapToDouble(h -> h.severity()).max().orElse(0) * 100;
        history.addLast(new double[]{c.now(), 100.0 * available / all.size(), avgBat, dispatcher.queue().size(), waiting, cong});
        while (history.size() > HISTORY) history.removeFirst();
    }

    Map<String, Object> build() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ts", c.now());
        m.put("dispatch", dispatch());
        m.put("energy", energy());
        m.put("traffic", traffic());
        m.put("anomalies", anomalyView());
        m.put("forecast", forecastView());
        return m;
    }

    // ───────────────────────── 1. task distribution ─────────────────────────
    private Map<String, Object> dispatch() {
        Map<String, Object> m = new LinkedHashMap<>();
        var d = c.cfg.dispatch;
        m.put("mode", c.mode);
        m.put("algorithm", d.hungarian ? "Hungarian (global optimum)" : "Greedy");
        m.put("assignments", dispatcher.assignments());
        m.put("lastDecision", dispatcher.lastDecision());
        m.put("weights", ordered("loadBalance", d.weightLoadBalance, "battery", d.weightBattery, "congestion", d.weightCongestion,
                "agingPerMin", d.agingPerMin, "agingCap", d.agingCap, "recentWindowS", d.recentWindowS));

        long now = c.now();
        long cutoff = now - (long) (d.recentWindowS * 1000);
        List<Object> queue = new ArrayList<>();
        int shown = 0;
        for (Task t : dispatcher.queue()) {
            if (shown++ >= 8) break;
            double base = switch (t.priority) { case STAT -> 100; case URGENT -> 50; case ROUTINE -> 20; };
            double pts = dispatcher.points(t);
            Map<String, Object> q = ordered("id", t.id, "priority", t.priority.name(), "item", t.item, "from", t.from, "to", t.to,
                    "fromName", name(t.from), "toName", name(t.to), "ageSec", Math.round((now - t.createdAt) / 1000.0),
                    "basePoints", base, "agingPoints", Math.round((pts - base) * 10) / 10.0, "points", Math.round(pts * 10) / 10.0);
            List<Map<String, Object>> cands = new ArrayList<>();
            for (Robot r : c.fleet.all()) {
                if (r.lastNodeId == null || c.map.node(r.lastNodeId) == null) continue;
                double cost = dispatcher.cost(t, r);
                String reason = null;
                if (!r.online) reason = "offline";
                else if (r.manual) reason = "manual control";
                else if (r.paused || r.estop || r.hasFatalError) reason = "paused / fault";
                else if (r.busy()) reason = "busy";
                else if (r.battery <= c.cfg.energy.criticalPct) reason = "battery critical";
                else if (r.charging && r.battery < c.cfg.energy.minReleasePct) reason = "charging (< " + Math.round(c.cfg.energy.minReleasePct) + " %)";
                else if (cost >= 1e9) reason = t.excludedRobots.contains(r.serial) ? "excluded for this task" : "not enough battery / no route";
                Double eta = c.router.shortest(r.lastNodeId, t.from, de.smartcare.core.routing.RouteConstraints.NONE).map(p -> Math.round(p.timeS() * 10) / 10.0).orElse(null);
                Map<String, Object> cand = ordered("robot", r.serial, "eligible", reason == null, "reason", reason, "etaToPickupSec", eta,
                        "battery", Math.round(r.battery * 10) / 10.0, "recentTasks", recent(r, cutoff), "cost", cost >= 1e9 ? null : Math.round(cost * 10) / 10.0);
                cands.add(cand);
            }
            cands.sort(Comparator.comparing((Map<String, Object> x) -> !(Boolean) x.get("eligible"))
                    .thenComparing(x -> x.get("cost") == null ? Double.MAX_VALUE : (Double) x.get("cost")));
            q.put("candidates", cands.size() > 5 ? cands.subList(0, 5) : cands);
            queue.add(q);
        }
        m.put("queue", queue);
        m.put("queueLength", dispatcher.queue().size());

        // load balancing: completed tasks per robot in the recent window
        List<Object> load = new ArrayList<>();
        double sum = 0; int n = 0; long max = 0, min = Long.MAX_VALUE;
        for (Robot r : c.fleet.all()) {
            long k = recent(r, cutoff);
            load.add(ordered("robot", r.serial, "recentTasks", k, "status", status.apply(r), "busy", r.busy(), "battery", Math.round(r.battery)));
            if (r.online && !r.manual) { sum += k; n++; max = Math.max(max, k); min = Math.min(min, k); }
        }
        double mean = n == 0 ? 0 : sum / n, var = 0;
        for (Robot r : c.fleet.all()) if (r.online && !r.manual) var += Math.pow(recent(r, cutoff) - mean, 2);
        double std = n == 0 ? 0 : Math.sqrt(var / n);
        // 100 = perfectly even, 0 = one robot does everything
        double balance = mean < 0.5 ? 100 : Math.max(0, 100 - 100 * std / Math.max(1, mean));
        m.put("load", load);
        m.put("balanceIndex", Math.round(balance));
        m.put("loadSpread", n == 0 ? 0 : max - min);
        long busy = c.fleet.all().stream().filter(Robot::busy).count();
        m.put("utilisationPct", c.fleet.all().isEmpty() ? 0 : Math.round(100.0 * busy / c.fleet.all().size()));
        return m;
    }

    private long recent(Robot r, long cutoff) { return r.completions.stream().filter(t -> t >= cutoff).count(); }

    // ───────────────────────── 2. energy ─────────────────────────
    private Map<String, Object> energy() {
        Map<String, Object> m = new LinkedHashMap<>();
        var e = c.cfg.energy;
        m.put("policy", ordered("critical", e.criticalPct, "low", e.lowPct, "target", e.targetPct, "minRelease", e.minReleasePct,
                "opportunisticBelow", e.opportunisticBelowPct, "reserve", e.reservePct));
        m.put("learnedPctPerMeter", Math.round(energy.pctPerMeter() * 10000) / 10000.0);
        m.put("consumptionSamples", energy.consumption.count());
        m.put("consumptionMean", Math.round(energy.consumption.mean() * 100000) / 100000.0);
        m.put("consumptionStd", Math.round(energy.consumption.std() * 100000) / 100000.0);
        m.put("chargeStops", energy.chargeStops());

        List<Object> robots = new ArrayList<>();
        int available = 0, charging = 0, low = 0;
        double sum = 0; int cnt = 0;
        for (Robot r : c.fleet.all()) {
            String level = r.battery <= e.criticalPct ? "CRITICAL" : r.battery < e.lowPct ? "LOW" : r.battery >= e.targetPct ? "FULL" : "OK";
            double range = Math.max(0, (r.battery - e.criticalPct - e.reservePct) / Math.max(1e-6, energy.pctPerMeter()));
            String action;
            if (!r.online) action = "Offline — excluded from planning";
            else if (r.charging) action = r.battery >= e.targetPct ? "Full — will be released" : r.battery >= e.minReleasePct ? "Charging — can be released if work waits" : "Charging to " + Math.round(e.minReleasePct) + " % minimum";
            else if (r.mission != null && r.mission.type == Mission.Type.CHARGE) action = "Driving to charger";
            else if (r.busy()) action = r.battery <= e.criticalPct ? "On task — battery critical" : "On task — range " + Math.round(range) + " m";
            else if (r.battery <= e.criticalPct) action = "Critical — no new work, charging";
            else if (r.battery < e.lowPct) action = "Low — sent to charger when idle";
            else if (r.battery < e.opportunisticBelowPct) action = "Tops up when no work is waiting";
            else action = "Ready for work";
            boolean avail = r.available(e.criticalPct);
            if (avail) available++;
            if (r.charging) charging++;
            if (r.online && r.battery < e.lowPct) low++;
            if (r.online) { sum += r.battery; cnt++; }
            robots.add(ordered("robot", r.serial, "battery", Math.round(r.battery * 10) / 10.0, "level", level, "charging", r.charging,
                    "available", avail, "rangeM", Math.round(range), "action", action, "online", r.online,
                    "consumptionZ", Math.round(energy.lastConsumptionZ.getOrDefault(r.serial, 0.0) * 10) / 10.0, "status", status.apply(r)));
        }
        m.put("robots", robots);
        m.put("availableNow", available);
        m.put("fleetSize", c.fleet.all().size());
        m.put("availabilityPct", c.fleet.all().isEmpty() ? 0 : Math.round(100.0 * available / c.fleet.all().size()));
        m.put("charging", charging);
        m.put("lowBattery", low);
        m.put("avgBattery", cnt == 0 ? 0 : Math.round(sum / cnt));

        List<Object> chargers = new ArrayList<>();
        for (MapNode ch : c.map.chargers()) {
            Set<String> at = c.reservations.holdersOfNode(ch.id());
            List<String> heading = new ArrayList<>();
            for (Robot r : c.fleet.all()) if (r.mission != null && !r.mission.finished() && r.mission.type == Mission.Type.CHARGE
                    && r.mission.legs.get(r.mission.legs.size() - 1).last().equals(ch.id()) && !at.contains(r.serial)) heading.add(r.serial);
            chargers.add(ordered("id", ch.id(), "name", ch.name(), "capacity", ch.capacity(), "occupied", at.size(), "robots", new ArrayList<>(at), "incoming", heading));
        }
        m.put("chargers", chargers);
        m.put("history", historySeries(1, 2));
        return m;
    }

    // ───────────────────────── 3. process control / traffic ─────────────────────────
    private Map<String, Object> traffic() {
        Map<String, Object> m = new LinkedHashMap<>();
        long now = c.now();
        var t = c.cfg.traffic;
        m.put("policy", ordered("lookaheadSegments", t.lookaheadSegments, "deadlockMinWaitS", t.deadlockMinWaitS,
                "autoResolve", c.cfg.anomaly.autoResolveDeadlocks, "predictionThreshold", t.predictionLoadThreshold));

        List<Object> coordination = new ArrayList<>();
        int driving = 0;
        for (Robot r : c.fleet.all()) {
            Mission mi = r.mission;
            boolean active = mi != null && !mi.finished();
            if (active) driving++;
            String waitNode = traffic.contestedNodes().get(r.serial);
            coordination.add(ordered("robot", r.serial, "status", status.apply(r), "mission", active ? mi.type.name() : null,
                    "taskId", active ? mi.taskId : null, "at", r.lastNodeId == null ? null : name(r.lastNodeId),
                    "heading", active ? name(mi.current().last()) : null,
                    "released", active ? Math.max(0, mi.current().releasedIdx - Math.max(0, mi.current().reachedIdx)) : 0,
                    "remaining", active ? Math.max(0, mi.current().path.size() - 1 - Math.max(0, mi.current().reachedIdx)) : 0,
                    "waitingFor", r.waitingOn, "waitSec", r.waitingOn == null ? 0 : Math.round((now - r.waitingSinceMs) / 1000.0),
                    "waitNode", waitNode == null ? null : name(waitNode)));
        }
        m.put("robots", coordination);
        m.put("activeMissions", driving);
        m.put("waitingRobots", c.fleet.all().stream().filter(r -> r.waitingOn != null).count());

        List<Object> dl = new ArrayList<>();
        for (var d : traffic.activeDeadlocks()) dl.add(ordered("robots", d.robots(), "resolution", d.resolution(), "ageSec", Math.round((now - d.detectedAt()) / 1000.0)));
        m.put("deadlocks", dl);
        m.put("deadlocksResolved", traffic.deadlocksResolved());
        List<Object> waitGraph = new ArrayList<>();
        traffic.waitGraph().forEach((r, bl) -> waitGraph.add(ordered("robot", r, "blockedBy", new ArrayList<>(bl))));
        m.put("waitGraph", waitGraph);

        // bottlenecks: nodes several robots are waiting for right now
        Map<String, List<String>> by = new LinkedHashMap<>();
        traffic.contestedNodes().forEach((r, n) -> by.computeIfAbsent(n, k -> new ArrayList<>()).add(r));
        List<Object> bn = new ArrayList<>();
        by.forEach((n, rs) -> bn.add(ordered("node", n, "name", name(n), "waiting", rs, "capacity", c.map.node(n).capacity())));
        m.put("bottlenecks", bn);

        // restricted & blocked areas
        List<Object> zones = new ArrayList<>();
        for (Zone z : c.map.zones()) {
            zones.add(ordered("id", z.id(), "name", z.name(), "restricted", z.restricted(), "nodes", z.nodeIds().size(), "edges", z.edgeIds().size(),
                    "nodeNames", z.nodeIds().stream().map(this::name).sorted().toList()));
        }
        m.put("zones", zones);
        List<Object> blocked = new ArrayList<>();
        for (String id : new TreeSet<>(c.router.blocked())) {
            MapEdge e = c.map.edge(id);
            blocked.add(ordered("id", id, "from", e == null ? null : name(e.a()), "to", e == null ? null : name(e.b())));
        }
        m.put("blockedEdges", blocked);

        // travel time optimisation: learned vs free-flow time per corridor, plus forecast hotspots
        List<Map<String, Object>> slow = new ArrayList<>();
        double sumLearned = 0, sumFree = 0;
        for (MapEdge e : c.map.edges()) {
            double free = e.length() / c.router.speedFor(e), learned = c.router.edgeTime(e);
            sumLearned += learned; sumFree += free;
            double load = c.reservations.edgeLoad(e.id()), util = predictor.utilNow(e.id());
            if (learned > free * 1.25 || load > 0 && util > 0.5) {
                slow.add(ordered("id", e.id(), "from", name(e.a()), "to", name(e.b()), "freeSec", Math.round(free * 10) / 10.0,
                        "learnedSec", Math.round(learned * 10) / 10.0, "slowdownPct", Math.round(100 * (learned / free - 1)), "utilisation", Math.round(util * 100) / 100.0));
            }
        }
        slow.sort(Comparator.comparingLong((Map<String, Object> o) -> -((Number) o.get("slowdownPct")).longValue()));
        m.put("slowCorridors", slow.size() > 8 ? slow.subList(0, 8) : slow);
        m.put("networkSlowdownPct", sumFree <= 0 ? 0 : Math.round(100 * (sumLearned / sumFree - 1)));
        List<Object> hs = new ArrayList<>();
        predictor.last().stream().sorted(Comparator.comparingInt(h -> h.horizonMin())).limit(12).forEach(h -> {
            MapEdge e = c.map.edge(h.zoneId());
            hs.add(ordered("edge", h.zoneId(), "from", e == null ? null : name(e.a()), "to", e == null ? null : name(e.b()),
                    "horizonMin", h.horizonMin(), "severity", h.severity(), "confidence", h.confidence()));
        });
        m.put("forecast", hs);
        m.put("history", historySeries(4, 5));
        return m;
    }

    // ───────────────────────── 4. anomaly detection ─────────────────────────
    private Map<String, Object> anomalyView() {
        Map<String, Object> m = new LinkedHashMap<>();
        var a = c.cfg.anomaly;
        long now = c.now();
        List<Insight> all = anomalies.all();
        List<Object> det = new ArrayList<>();

        // live "closeness to threshold" values so the operator sees what is being watched, not only what fired
        double maxIdle = 0;
        for (Robot r : c.fleet.all()) if (r.online && r.mission == null && !r.charging && !r.manual) maxIdle = Math.max(maxIdle, (now - r.idleSinceMs) / 1000.0);
        double maxZ = 0;
        for (double z : energy.lastConsumptionZ.values()) maxZ = Math.max(maxZ, z);
        double oldest = 0, ratio = 0;
        for (Task t : dispatcher.queue()) {
            double age = (now - t.createdAt) / 1000.0;
            oldest = Math.max(oldest, age);
            double lim = a.queuedWarnS * (t.priority == Task.Priority.STAT ? 0.34 : t.priority == Task.Priority.URGENT ? 0.67 : 1.0);
            ratio = Math.max(ratio, age / lim);
        }
        int maxWait = 0;
        Map<String, Integer> w = new HashMap<>();
        traffic.contestedNodes().forEach((r, n) -> w.merge(n, 1, Integer::sum));
        for (int v : w.values()) maxWait = Math.max(maxWait, v);

        det.add(detector("idle", "Unusually long idle time", "A robot waits for work longer than the limit.",
                "> " + Math.round(a.idleWarnS / 60) + " min idle", Math.round(maxIdle), a.idleWarnS, "s", Set.of("IDLE"), all));
        det.add(detector("battery", "Abnormal battery consumption", "Energy use per metre is far above the fleet average (z-score), or a robot works below the critical level.",
                "z ≥ " + a.batteryZ, Math.round(maxZ * 10) / 10.0, a.batteryZ, "z", Set.of("BATTERY"), all));
        det.add(detector("orders", "Blocked or unprocessed orders", "Orders wait too long for a robot (limit depends on priority) or a robot stops on its route.",
                "> " + Math.round(a.queuedWarnS) + " s (STAT ×0.34, URGENT ×0.67); no progress > " + Math.round(a.noProgressS) + " s",
                Math.round(oldest), a.queuedWarnS, "s", Set.of("UNPROCESSED", "BLOCKED"), all));
        det.add(detector("bottleneck", "Traffic bottlenecks", "Several robots queue for the same node, or a corridor is forecast to be overloaded.",
                "≥ " + a.bottleneckMinRobots + " robots waiting > " + Math.round(a.bottleneckWaitS) + " s", maxWait, a.bottleneckMinRobots, "robots",
                Set.of("BOTTLENECK", "CONGESTION"), all));
        det.add(detector("deadlock", "Deadlocks", "Robots block each other in a cycle; the core re-routes the lowest-priority one.",
                "wait > " + Math.round(c.cfg.traffic.deadlockMinWaitS) + " s in a cycle", traffic.activeDeadlocks().size(), 1, "", Set.of("DEADLOCK"), all));
        det.add(detector("offline", "Robot offline", "No VDA 5050 state message within " + Math.round(c.cfg.core.robotOfflineS) + " s.",
                "no state > " + Math.round(c.cfg.core.robotOfflineS) + " s", c.fleet.all().stream().filter(r -> !r.online).count(), 1, "robots", Set.of("OFFLINE"), all));
        m.put("detectors", det);
        m.put("autoResolve", a.autoResolveDeadlocks);

        List<Object> recent = new ArrayList<>();
        all.stream().sorted(Comparator.comparingLong((Insight i) -> i.updatedAt).reversed()).limit(10).forEach(i ->
                recent.add(ordered("id", i.id, "category", i.category, "severity", i.severity, "title", i.title, "state", i.state,
                        "ageSec", Math.round((now - i.createdAt) / 1000.0), "message", i.staffMessage)));
        m.put("recent", recent);
        m.put("activeCount", anomalies.activeCount());
        return m;
    }

    private Map<String, Object> detector(String id, String title, String description, String rule, Number current, double limit, String unit, Set<String> cats, List<Insight> all) {
        long active = all.stream().filter(i -> cats.contains(i.category) && i.active()).count();
        long recent = all.stream().filter(i -> cats.contains(i.category)).count();
        String state = active > 0 ? "FIRING" : limit > 0 && current.doubleValue() >= 0.7 * limit ? "WATCH" : "OK";
        return ordered("id", id, "title", title, "description", description, "rule", rule, "current", current, "limit", limit, "unit", unit,
                "state", state, "active", active, "recent", recent);
    }

    // ───────────────────────── 5. learned demand forecast ─────────────────────────
    private Map<String, Object> forecastView() {
        Map<String, Object> m = new LinkedHashMap<>();
        long now = c.now();
        var a = c.cfg.ai;
        double mae = forecaster.mae(), naive = forecaster.naiveMae();
        m.put("enabled", a.forecast);
        m.put("ready", forecaster.ready());
        m.put("model", "Online demand model: smoothed level + hour-of-day profile");
        m.put("bucketSeconds", forecaster.bucketSeconds());
        m.put("trainedBuckets", forecaster.trainedBuckets());
        m.put("minBuckets", a.minBuckets);
        m.put("mae", Math.round(mae * 100) / 100.0);
        m.put("naiveMae", Math.round(naive * 100) / 100.0);
        m.put("improvementPct", naive > 0 ? Math.round(100 * (naive - mae) / naive) : 0);
        double e10 = forecaster.expectedTotal(now, 10);
        m.put("expected10", Math.round(e10 * 10) / 10.0);
        m.put("expected30", Math.round(forecaster.expectedTotal(now, 30) * 10) / 10.0);
        m.put("busyThreshold", a.busyOrdersPer10Min);
        m.put("demandLevel", !forecaster.ready() ? "LEARNING" : e10 >= a.busyOrdersPer10Min ? "HIGH" : e10 >= a.busyOrdersPer10Min / 2 ? "NORMAL" : "LOW");
        m.put("prePosition", a.prePosition);
        List<Object> st = new ArrayList<>();
        Map<String, Double> p10 = forecaster.perStation(now, 10), p30 = forecaster.perStation(now, 30);
        p10.entrySet().stream().sorted((x, y) -> Double.compare(y.getValue(), x.getValue())).limit(8).forEach(en -> {
            String id = en.getKey();
            List<String> there = new ArrayList<>();
            for (Robot r : c.fleet.all()) {
                if (!r.online) continue;
                boolean parked = r.mission == null && id.equals(r.lastNodeId);
                boolean heading = r.mission != null && !r.mission.finished() && r.mission.type == Mission.Type.GOTO && id.equals(r.mission.legs.get(r.mission.legs.size() - 1).last());
                if (parked || heading) there.add(r.serial);
            }
            st.add(ordered("id", id, "name", name(id), "expected10", Math.round(en.getValue() * 10) / 10.0,
                    "expected30", Math.round(p30.getOrDefault(id, 0.0) * 10) / 10.0, "robots", there));
        });
        m.put("stations", st);
        List<Object> hist = new ArrayList<>();
        for (var p : forecaster.history()) hist.add(ordered("t", p.ts(), "a", p.actual(), "b", Math.round(p.predicted() * 100) / 100.0));
        m.put("history", hist);
        List<Object> dec = new ArrayList<>();
        for (var d : decisions.recent()) dec.add(ordered("type", d.type(), "text", d.text(), "ageSec", Math.round((now - d.ts()) / 1000.0)));
        m.put("decisions", dec);
        m.put("counters", new LinkedHashMap<>(decisions.counters()));
        return m;
    }

    // ───────────────────────── helpers ─────────────────────────
    private List<Object> historySeries(int colA, int colB) {
        List<Object> out = new ArrayList<>();
        int step = Math.max(1, history.size() / 60), i = 0;
        for (double[] s : history) {
            if (i++ % step != 0) continue;
            out.add(ordered("t", (long) s[0], "a", Math.round(s[colA] * 10) / 10.0, "b", Math.round(s[colB] * 10) / 10.0));
        }
        return out;
    }

    private String name(String nodeId) { MapNode n = nodeId == null ? null : c.map.node(nodeId); return n == null ? String.valueOf(nodeId) : n.name(); }

    private static Map<String, Object> ordered(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }
}
