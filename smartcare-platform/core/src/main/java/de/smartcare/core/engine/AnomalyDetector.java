package de.smartcare.core.engine;

import de.smartcare.core.event.Dto;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.insight.Insight;
import de.smartcare.core.insight.Narrator;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.task.Task;

import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * Rule + statistics based anomaly detection:
 * long idle times, abnormal battery consumption (z-score), blocked/unprocessed orders, stalled vehicles,
 * offline vehicles, traffic bottlenecks, deadlocks and forecast congestion. Findings become {@link Insight}s with a
 * stable key so repeated detections update one insight instead of creating duplicates.
 */
final class AnomalyDetector {
    private final Context c;
    private final TrafficController traffic;
    private final EnergyManager energy;
    private final Dispatcher dispatcher;
    private final Predictor predictor;
    private final Narrator narrator;
    private final Map<String, Insight> byKey = new LinkedHashMap<>();
    private final Map<String, Insight> byId = new LinkedHashMap<>();
    private final Map<String, Long> suppressedUntil = new HashMap<>();
    private final Set<String> seenThisCycle = new HashSet<>();
    private final Consumer<Runnable> underLock;
    private ExecutorService llm;
    private int seq;

    AnomalyDetector(Context c, TrafficController t, EnergyManager e, Dispatcher d, Predictor p, Narrator narrator, Consumer<Runnable> underLock) {
        this.c = c; this.traffic = t; this.energy = e; this.dispatcher = d; this.predictor = p; this.narrator = narrator; this.underLock = underLock;
    }

    List<Insight> all() { return new ArrayList<>(byId.values()); }
    Insight get(String id) { return byId.get(id); }
    long activeCount() { return byId.values().stream().filter(Insight::active).count(); }

    void dismiss(Insight i, long now) { i.state = "DISMISSED"; i.updatedAt = now; suppressedUntil.put(i.key, now + 600_000L); publish(i); }
    void acknowledge(Insight i, long now) { if (i.active()) { i.state = "ACKNOWLEDGED"; i.updatedAt = now; publish(i); } }
    void applied(Insight i, long now) { i.state = "ACTION_APPLIED"; i.updatedAt = now; publish(i); }

    void evaluate() {
        long now = c.now();
        seenThisCycle.clear();
        var a = c.cfg.anomaly;

        // 1. offline / stalled / idle / battery per robot
        for (Robot r : c.fleet.all()) {
            if (!r.online) {
                raise("offline:" + r.serial, "OFFLINE", "CRITICAL", r.serial + " is offline", "A robot is not responding; its work was handed to other robots.",
                        null, null, 0, 0.95, 0, command("TAKE_MANUAL", r.serial, "Take " + r.serial + " out of automatic planning", 0));
                continue;
            }
            Mission m = r.mission;
            if (m != null && !m.finished() && r.waitingOn == null && !r.paused && !r.manual && m.current().sent
                    && r.state != null && m.current().orderId.equals(r.state.orderId())
                    && now - r.lastMoveMs > a.noProgressS * 1000L && now - m.current().lastProgressMs > a.noProgressS * 1000L
                    && m.current().releasedIdx > m.current().reachedIdx) {
                raise("stall:" + r.serial, "BLOCKED", "CRITICAL", r.serial + " is not making progress", "A robot has stopped on its route.",
                        null, null, 0, 0.85, taskCount(r), command("TAKE_MANUAL", r.serial, "Take over " + r.serial, 5));
            }
            if (m == null && r.online && !r.charging && !r.manual && now - r.idleSinceMs > a.idleWarnS * 1000L && r.battery > c.cfg.energy.lowPct) {
                raise("idle:" + r.serial, "IDLE", "INFO", r.serial + " idle for " + (now - r.idleSinceMs) / 60000 + " min",
                        "A robot has been waiting for work for a long time.", null, r.lastNodeId, 0, 0.8, 0, null);
            }
            Double z = energy.lastConsumptionZ.get(r.serial);
            if (z != null && z >= a.batteryZ) {
                raise("battery:" + r.serial, "BATTERY", "WARNING", r.serial + " uses unusually much energy",
                        "A robot is consuming more battery than the rest of the fleet (z=" + Math.round(z * 10) / 10.0 + ").", null, null, 0, Math.min(0.95, 0.5 + z / 10), 0,
                        command("CHARGE", r.serial, "Send " + r.serial + " to charge and inspect", 3));
            }
            if (m != null && !m.finished() && m.type == Mission.Type.TASK && r.battery <= c.cfg.energy.criticalPct && !r.charging) {
                raise("lowbat:" + r.serial, "BATTERY", "CRITICAL", r.serial + " battery critical while on a task", "Battery below the critical limit.", null, null, 0, 0.9, 1, null);
            }
        }

        // 2. unprocessed orders
        for (Task t : c.tasks.values()) {
            if (!t.isQueued()) continue;
            double age = (now - t.createdAt) / 1000.0;
            double limit = a.queuedWarnS * (t.priority == Task.Priority.STAT ? 0.34 : t.priority == Task.Priority.URGENT ? 0.67 : 1.0);
            if (age > limit) {
                String sev = t.priority == Task.Priority.STAT ? "CRITICAL" : "WARNING";
                raise("queued:" + t.id, "UNPROCESSED", sev, t.id + " waiting " + Math.round(age) + " s without a robot",
                        "Your request is waiting for a free robot.", null, t.from, 0, 0.9, 1, null);
            }
        }

        // 3. traffic: deadlocks and bottlenecks
        for (TrafficController.Deadlock d : traffic.activeDeadlocks()) {
            String key = "deadlock:" + String.join("+", d.robots().stream().sorted().toList());
            boolean solved = !d.resolution().equals("none") && !d.resolution().equals("awaiting operator");
            raise(key, "DEADLOCK", solved ? "WARNING" : "CRITICAL", "Deadlock between " + String.join(", ", d.robots()) + (solved ? " (" + d.resolution() + ")" : ""),
                    "Robots blocked each other in a corridor.", null, null, 0, 0.95, d.robots().size(),
                    solved ? null : command("TAKE_MANUAL", d.robots().get(0), "Take over " + d.robots().get(0) + " to free the corridor", 5));
        }
        Map<String, List<String>> waiting = new HashMap<>();
        for (Robot r : c.fleet.all()) {
            String node = traffic.contestedNodes().get(r.serial);
            if (node != null && r.waitingOn != null && now - r.waitingSinceMs > a.bottleneckWaitS * 1000L) waiting.computeIfAbsent(node, k -> new ArrayList<>()).add(r.serial);
        }
        waiting.forEach((node, rs) -> {
            if (rs.size() >= a.bottleneckMinRobots) {
                raise("bottleneck:" + node, "BOTTLENECK", "WARNING", rs.size() + " robots queuing for " + c.map.node(node).name(),
                        "Several robots are waiting at the same spot.", null, node, 0, 0.85, rs.size(), null);
            }
        });

        // 4. forecast congestion
        for (Dto.Hotspot h : predictor.last()) {
            if (h.severity() >= 0.85 && h.horizonMin() <= 15) {
                raise("forecast:" + h.zoneId(), "CONGESTION", "WARNING", "Congestion expected on " + h.zoneId() + " in about " + h.horizonMin() + " min",
                        "A corridor will be busy soon; deliveries may take longer.", h.zoneId(), null, h.horizonMin(), h.confidence(), 0,
                        command("BLOCK_ZONE", h.zoneId(), "Re-route traffic around " + h.zoneId(), 4));
            }
        }

        // resolve what is no longer detected
        for (Insight i : byId.values()) {
            if (i.active() && !seenThisCycle.contains(i.key)) { i.state = "RESOLVED"; i.updatedAt = now; publish(i); }
        }
        byId.values().removeIf(i -> !i.active() && now - i.updatedAt > 600_000L && !"ACTION_APPLIED".equals(i.state));
        byKey.values().removeIf(i -> !byId.containsKey(i.id));
    }

    private int taskCount(Robot r) { return r.mission != null && r.mission.taskId != null ? 1 : 0; }

    private Dto.SuggestedAction command(String type, String target, String label, double impactMin) {
        return new Dto.SuggestedAction("sa-" + type + "-" + target, label, impactMin, new Dto.CommandRequest(type, target, Map.of(), "insight", null));
    }

    private void raise(String key, String cat, String sev, String title, String staffMsg, String zone, String station,
                       double eta, double conf, int affected, Dto.SuggestedAction sug) {
        long now = c.now();
        if (suppressedUntil.getOrDefault(key, 0L) > now) return;
        seenThisCycle.add(key);
        Insight i = byKey.get(key);
        boolean isNew = i == null || !i.active();
        if (isNew) {
            i = new Insight("ins-" + (++seq), key, cat);
            i.createdAt = now;
            byKey.put(key, i);
            byId.put(i.id, i);
        }
        boolean changed = isNew || !title.equals(i.title) || !sev.equals(i.severity) || affected != i.affectedTasks;
        i.severity = sev; i.title = title; i.zoneId = zone; i.stationId = station; i.etaMin = eta; i.confidence = conf;
        i.affectedTasks = affected; i.suggestion = sug; i.validUntil = now + 300_000L; i.updatedAt = now;
        if (i.staffMessage == null) i.staffMessage = staffMsg;
        if (changed) {
            publish(i);
            if (isNew) narrate(i, staffMsg);
        }
    }

    private void narrate(Insight i, String ruleText) {
        if (narrator == null || !c.cfg.llm.enabled || i.narrated) return;
        i.narrated = true;
        if (llm == null) llm = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "llm-narrator"); t.setDaemon(true); return t; });
        final String facts = i.title + "; severity=" + i.severity + "; affectedTasks=" + i.affectedTasks;
        final String cat = i.category;
        llm.submit(() -> {
            String text = narrator.narrate(cat, ruleText, facts);
            if (text != null && !text.isBlank()) underLock.accept(() -> { i.staffMessage = text; publish(i); });
        });
    }

    private void publish(Insight i) { c.bus.publish("ai.insights", i.dto()); }
}
