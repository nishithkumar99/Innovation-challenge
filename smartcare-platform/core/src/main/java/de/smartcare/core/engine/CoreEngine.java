package de.smartcare.core.engine;

import de.smartcare.core.ai.DemandForecaster;
import de.smartcare.core.event.Dto;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.insight.AnthropicNarrator;
import de.smartcare.core.insight.Insight;
import de.smartcare.core.insight.Narrator;
import de.smartcare.core.kpi.KpiService;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.mqtt.MqttGateway;
import de.smartcare.core.settings.Settings;
import de.smartcare.core.task.Task;
import de.smartcare.core.vda.Messages.*;
import de.smartcare.core.vda.Vda;

import java.util.*;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;

/**
 * The fleet management core. One lock serialises MQTT callbacks, REST calls and the periodic {@link #tick()};
 * all planning code therefore runs single-threaded and needs no further synchronisation.
 */
public final class CoreEngine implements MissionService.TaskEvents {
    private final ReentrantLock lock = new ReentrantLock();
    final Context c;
    final MissionService missions;
    final EnergyManager energy;
    final Dispatcher dispatcher;
    final TrafficController traffic;
    final Predictor predictor;
    final AnomalyDetector anomalies;
    final CommandService commands;
    final IntelService intel;
    final DemandForecaster forecaster;
    final AiDecisions aiDecisions = new AiDecisions();
    final Positioner positioner;
    final Homing homing;
    final KpiService kpi;
    private int taskCounter = 1000;
    private long lastTelemetry, lastSlow, lastKpiSample;
    private Dto.KpiLive lastKpi;

    public CoreEngine(HospitalMap map, Settings cfg, LongSupplier clock, MqttGateway mqtt) {
        this(map, cfg, clock, mqtt, cfg.llm.enabled && !cfg.llm.apiKey.isBlank() ? new AnthropicNarrator(cfg.llm) : null);
    }

    public CoreEngine(HospitalMap map, Settings cfg, LongSupplier clock, MqttGateway mqtt, Narrator narrator) {
        this.c = new Context(map, cfg, clock, mqtt);
        this.missions = new MissionService(c, this);
        this.forecaster = new DemandForecaster(cfg.ai.bucketSeconds, cfg.ai.minBuckets);
        this.energy = new EnergyManager(c, missions, forecaster, aiDecisions);
        this.positioner = new Positioner(c, missions, forecaster, aiDecisions);
        this.homing = new Homing(c, missions, positioner);
        this.dispatcher = new Dispatcher(c, missions, energy);
        this.traffic = new TrafficController(c, missions);
        this.predictor = new Predictor(c, dispatcher);
        this.anomalies = new AnomalyDetector(c, traffic, energy, dispatcher, predictor, narrator, this::locked);
        this.commands = new CommandService(this);
        this.intel = new IntelService(c, dispatcher, energy, traffic, predictor, anomalies, this::status, forecaster, aiDecisions, positioner);
        this.kpi = new KpiService(cfg.dispatch.handoverS, clock.getAsLong());
        c.mode = cfg.dispatch.mode;
        c.aiAvailable = true;
        // congestion-aware routing: reserved edges and forecast utilisation make a corridor "longer" for new routes
        c.router.setCongestionPenalty(e -> c.cfg.dispatch.weightCongestion * 0.5 * c.reservations.edgeLoad(e) + 10 * predictor.utilNow(e));
    }

    public Context context() { return c; }

    /** Subscribes to the vehicles' state and connection topics. */
    public void start() {
        c.mqtt.subscribe(c.topics.allStates(), c.cfg.mqtt.stateQos, (t, p) -> onState(t, p));
        c.mqtt.subscribe(c.topics.allConnections(), c.cfg.mqtt.connectionQos, (t, p) -> onConnection(t, p));
    }

    // ───── MQTT ingestion ─────
    void onConnection(String topic, String json) {
        String[] id = c.topics.parse(topic);
        if (id == null) return;
        locked(() -> {
            Connection conn;
            try { conn = c.codec.fromJson(json, Connection.class); } catch (RuntimeException e) { return; }
            Robot r = c.fleet.getOrCreate(id[0], id[1], c.now());
            boolean was = r.online;
            r.online = Vda.ConnectionState.ONLINE.equals(conn.connectionState());
            r.lastSeenMs = c.now();
            if (!r.online && was) robotLost(r, "Robot " + r.serial + " reported " + conn.connectionState());
        });
    }

    void onState(String topic, String json) {
        String[] id = c.topics.parse(topic);
        if (id == null) return;
        locked(() -> {
            State s;
            try { s = c.codec.fromJson(json, State.class); } catch (RuntimeException e) { return; }
            if (c.segmented != null) s = c.segmented.inbound(id[1], s);
            Robot r = c.fleet.getOrCreate(id[0], id[1], c.now());
            r.state = s;
            r.online = true;
            r.lastSeenMs = c.now();
            if (s.agvPosition() != null) {
                if (Math.hypot(s.agvPosition().x() - r.x, s.agvPosition().y() - r.y) > 0.005) r.lastMoveMs = c.now();   // the organizers' simulator drives at 0.05 m/s and reports at 1 Hz
                r.x = s.agvPosition().x(); r.y = s.agvPosition().y(); r.heading = s.agvPosition().theta();
            }
            if (s.batteryState() != null) { r.battery = s.batteryState().batteryCharge(); r.charging = s.batteryState().charging(); }
            r.driving = s.driving();
            r.speed = s.velocity() != null && s.velocity().vx() != null && s.driving() ? Math.abs(s.velocity().vx()) : 0;
            r.paused = Boolean.TRUE.equals(s.paused());
            r.stateOrderId = s.orderId();
            String reportedNode = s.lastNodeId();
            if ((reportedNode == null || reportedNode.isBlank() || c.map.node(reportedNode) == null) && s.agvPosition() != null) {
                // Some vehicles (e.g. the organizers' simulator at start-up) report no node. Treat a vehicle standing next to a node as being at it.
                reportedNode = c.map.nearest(s.agvPosition().x(), s.agvPosition().y(), c.cfg.map.snapRadiusM).map(n -> n.id()).orElse(reportedNode);
            }
            r.lastNodeId = reportedNode;
            r.lastNodeSeq = s.lastNodeSequenceId();
            r.estop = s.safetyState() != null && s.safetyState().eStop() != null && !"NONE".equals(s.safetyState().eStop());
            r.hasFatalError = s.errors() != null && s.errors().stream().anyMatch(e -> Vda.ErrorLevel.FATAL.equals(e.errorLevel()));
            if (r.mission == null) c.reservations.releaseAllExcept(r.serial, c.occupiedNode(r));
            missions.onState(r);
        });
    }

    // ───── periodic loop ─────
    public void tick() {
        locked(() -> {
            long now = c.now();
            for (Robot r : c.fleet.all()) {
                if (r.online && now - r.lastSeenMs > c.cfg.core.robotOfflineS * 1000L) { r.online = false; robotLost(r, "Robot " + r.serial + " stopped sending state"); }
                if (r.mission != null && r.online && r.state != null) missions.onState(r); // ack timeout is time-based
            }
            if (c.segmented != null) c.segmented.tick();
            traffic.tick();
            energy.tick(dispatcher.queue().size());
            dispatcher.tick();
            homing.tick(dispatcher.queue().size());
            forecaster.advance(now);
            positioner.tick(dispatcher.queue().size());
            updateEtas();
            if (now - lastTelemetry >= c.cfg.core.telemetryMs) {
                lastTelemetry = now;
                publishRobots();
            }
            if (now - lastSlow >= 1000) {
                lastSlow = now;
                predictor.compute();
                intel.sample();
                anomalies.evaluate();
                c.bus.publish("fleet.zones", zonesPayload());
                c.bus.publish("ai.predictions", new Dto.PredictionsPayload(now, predictor.last()));
                lastKpi = kpi.compute(c.tasks.values(), now);
                c.bus.publish("kpi.live", lastKpi);
                if (now - lastKpiSample >= 10_000) { lastKpiSample = now; kpi.sample(lastKpi.point()); }
            }
        });
    }

    private void updateEtas() {
        for (Task t : c.tasks.values()) {
            if (!t.isOpen()) continue;
            if (t.robotId == null) { t.etaSec = null; continue; }
            Robot r = c.fleet.get(t.robotId);
            if (r != null) t.etaSec = Math.round(missions.remainingSeconds(r)) + 0.0;
        }
    }

    void publishRobots() {
        List<Dto.RobotDto> l = new ArrayList<>();
        for (Robot r : c.fleet.all()) l.add(robotDto(r));
        if (!l.isEmpty()) c.bus.publish("fleet.robots", l);
    }

    Dto.RobotDto robotDto(Robot r) {
        List<String> route = List.of(), plan = List.of();
        Mission m = r.mission;
        if (m != null && !m.finished()) {
            Mission.Leg l = m.current();
            route = l.path.subList(Math.min(l.reachedIdx + 1, l.path.size()), l.path.size());
            if (m.legIdx + 1 < m.legs.size()) plan = m.legs.get(m.legIdx + 1).path;
        }
        return new Dto.RobotDto(r.serial, r.serial, new Dto.Vec(r.x, r.y), r.heading, r.speed, r.battery, status(r),
                m != null ? m.taskId : null, route, plan, c.now());
    }

    String status(Robot r) {
        if (r.hasFatalError || r.estop || r.latched) return "FAULT";
        if (r.manual) return "MANUAL_OVERRIDE";
        if (r.paused) return "PAUSED";
        if (r.charging) return "CHARGING";
        Mission m = r.mission;
        if (m != null && !m.finished()) {
            if (r.waitingOn != null) return "WAITING";
            return m.current().role == Mission.Role.DROP ? "CARRYING" : "EN_ROUTE_TO_PICKUP";
        }
        return "IDLE";
    }

    // ───── tasks ─────

    public String createTask(String source, String from, String to, String priority, String item, String notes, String origin,
                             String userId, String userName) {
        return locked(() -> {
            validate(from, to);
            String id = "T-" + (++taskCounter);
            Task t = new Task(id, source, from, to, Task.Priority.valueOf(priority), userId, userName, item, notes, origin, c.now());
            c.tasks.put(id, t);
            forecaster.record(from, c.now());
            trimTasks();
            c.bus.publish("tasks.events", List.of(TaskMapper.dto(t)));
            return id;
        });
    }

    private void validate(String from, String to) {
        MapNode a = c.map.node(from), b = c.map.node(to);
        if (a == null) throw new IllegalArgumentException("Unknown pickup station: " + from);
        if (b == null) throw new IllegalArgumentException("Unknown delivery station: " + to);
        if (from.equals(to)) throw new IllegalArgumentException("Pickup and delivery must differ");
        if (a.isCharger() || b.isCharger()) throw new IllegalArgumentException("Charging stations cannot be used for transport tasks");
    }

    private void trimTasks() {
        if (c.tasks.size() <= c.cfg.core.taskRetention) return;
        Iterator<Task> it = c.tasks.values().iterator();
        while (it.hasNext() && c.tasks.size() > c.cfg.core.taskRetention) { if (!it.next().isOpen()) it.remove(); }
    }

    // ───── MissionService callbacks ─────
    @Override public void taskChanged(Task t) { c.bus.publish("tasks.events", List.of(TaskMapper.dto(t))); }
    @Override public void legDone(Robot r, Mission.Leg leg) { energy.observeLeg(r, leg); }

    @Override public void missionFailed(Robot r, String reason) {
        Task t = missions.taskOf(r);
        if (t != null && t.isOpen()) {
            t.excludedRobots.add(r.serial);
            t.status = Task.Status.QUEUED; t.robotId = null; t.pickedAt = null; t.assignedAt = null; t.touch();
            taskChanged(t);
        }
        c.reservations.releaseAllExcept(r.serial, c.occupiedNode(r));
        r.mission = null;
        r.idleSinceMs = c.now();
        c.notice = reason;
    }

    private void robotLost(Robot r, String reason) {
        if (r.mission != null) missionFailed(r, reason);
    }


    // ───── public API used by REST / WebSocket ─────
    public Dto.ValidationResult validateTask(String from, String to, String priority) {
        return locked(() -> {
            List<String> errors = new ArrayList<>(), warnings = new ArrayList<>();
            try { validate(from, to); } catch (IllegalArgumentException e) { errors.add(e.getMessage()); }
            if (errors.isEmpty()) {
                if (c.fleet.all().stream().noneMatch(r -> r.online)) warnings.add("No robot is online right now; the request will wait in the queue.");
                else if (c.fleet.all().stream().noneMatch(r -> r.online && r.battery > c.cfg.energy.minReleasePct)) warnings.add("All robots are low on battery; expect a delay.");
                long queued = dispatcher.queue().size();
                if (queued > 5) warnings.add(queued + " requests are already waiting.");
                if (c.router.shortestIgnoringTraffic(from, to).isEmpty()) errors.add("There is no route between these stations.");
            }
            return new Dto.ValidationResult(errors.isEmpty(), errors, warnings);
        });
    }

    public void command(Dto.CommandRequest cmd, String correlationId, String actor) { locked(() -> commands.execute(cmd, correlationId, actor)); }

    public void applyInsight(String id, String correlationId, String actor) {
        locked(() -> {
            Insight i = anomalies.get(id);
            if (i == null) { commands.execute(new Dto.CommandRequest("NOOP", null, null, null, null), correlationId, actor); return; }
            if (i.suggestion == null) { c.bus.publish("commands.acks", new Dto.CommandAck(correlationId, "REJECTED", "This insight has no suggested action")); return; }
            commands.execute(i.suggestion.command(), correlationId, actor);
            anomalies.applied(i, c.now());
        });
    }
    public void dismissInsight(String id) { locked(() -> { Insight i = anomalies.get(id); if (i != null) anomalies.dismiss(i, c.now()); }); }
    public void acknowledgeInsight(String id) { locked(() -> { Insight i = anomalies.get(id); if (i != null) anomalies.acknowledge(i, c.now()); }); }
    public List<Dto.KpiPoint> kpiSeries(String window) { return locked(() -> kpi.series(window, c.now())); }
    public List<Dto.InsightDto> insights() { return locked(() -> anomalies.all().stream().map(Insight::dto).toList()); }

    Dto.SystemStatus systemStatus() {
        return new Dto.SystemStatus(c.mode, c.hold, c.aiAvailable, new ArrayList<>(new TreeSet<>(c.router.blocked())), c.notice);
    }

    Dto.ZonesPayload zonesPayload() {
        List<Dto.ZoneOccupancy> zones = new ArrayList<>();
        for (var e : c.map.edges()) zones.add(new Dto.ZoneOccupancy(e.id(), e.a(), e.b(), c.reservations.edgeLoad(e.id()), c.router.isBlocked(e.id())));
        return new Dto.ZonesPayload(zones, stationQueues());
    }

    private List<Dto.StationQueue> stationQueues() {
        Map<String, Integer> q = new HashMap<>();
        for (Task t : c.tasks.values()) if (t.isQueued() || t.status == Task.Status.ASSIGNED || t.status == Task.Status.TO_PICKUP) q.merge(t.from, 1, Integer::sum);
        List<Dto.StationQueue> l = new ArrayList<>();
        for (MapNode n : c.map.stations()) l.add(new Dto.StationQueue(n.id(), q.getOrDefault(n.id(), 0)));
        return l;
    }

    public Dto.Snapshot snapshot() {
        return locked(() -> {
            long now = c.now();
            List<Dto.StationDto> stations = new ArrayList<>();
            Map<String, Integer> queues = new HashMap<>();
            stationQueues().forEach(sq -> queues.put(sq.id(), sq.queue()));
            for (MapNode n : c.map.stations()) stations.add(new Dto.StationDto(n.id(), n.name(), n.kind().name(), new Dto.Vec(n.x(), n.y()), queues.getOrDefault(n.id(), 0)));
            Dto.KpiLive k = lastKpi != null ? lastKpi : kpi.compute(c.tasks.values(), now);
            return new Dto.Snapshot(c.bus.seq(), now, robotsSnapshotUnlocked(), zonesPayload().zones(), stations, predictor.last(),
                    c.tasks.values().stream().map(TaskMapper::dto).toList(),
                    anomalies.all().stream().filter(i -> i.active() || "ACTION_APPLIED".equals(i.state)).map(Insight::dto).toList(), k, systemStatus());
        });
    }

    private List<Dto.RobotDto> robotsSnapshotUnlocked() { return c.fleet.all().stream().map(this::robotDto).toList(); }

    /** Static map description for the UI (nodes and edges). */
    public HospitalMap map() { return c.map; }

    /** Explanations of the AI decisions (dispatch, energy, traffic, anomalies) for the operator UI. */
    public Map<String, Object> intel() { return locked(() -> intel.build()); }

    /** Diagnostics for operators and tests. */
    public Map<String, Object> diagnostics() {
        return locked(() -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("assignments", dispatcher.assignments());
            m.put("lastDispatch", dispatcher.lastDecision());
            m.put("deadlocksResolved", traffic.deadlocksResolved());
            m.put("activeDeadlocks", traffic.activeDeadlocks().size());
            m.put("learnedEnergyPctPerMeter", Math.round(energy.pctPerMeter() * 10000) / 10000.0);
            m.put("openInsights", anomalies.activeCount());
            m.put("mode", c.mode);
            m.put("hold", c.hold);
            return m;
        });
    }

    // ───── helpers ─────
    <T> T locked(java.util.function.Supplier<T> s) { lock.lock(); try { return s.get(); } finally { lock.unlock(); } }
    void locked(Runnable r) { lock.lock(); try { r.run(); } finally { lock.unlock(); } }

    public Task task(String id) { return locked(() -> c.tasks.get(id)); }
    public List<Dto.TaskDto> tasksSnapshot() { return locked(() -> c.tasks.values().stream().map(TaskMapper::dto).toList()); }
    public List<Dto.RobotDto> robotsSnapshot() { return locked(() -> c.fleet.all().stream().map(this::robotDto).toList()); }
}
