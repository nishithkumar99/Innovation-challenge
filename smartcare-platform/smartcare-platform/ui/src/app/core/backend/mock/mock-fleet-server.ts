import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { MAP_EDGES, MAP_NODES, NODE_BY_ID, STATION_NODES, WARD_IDS, idsOfKind, stationName } from '../../map-data';
import { Intel } from '../../intel.models';
import { buildMockIntel } from './mock-intel';
import {
  AckState, CommandAck, CommandRequest, Envelope, HorizonMin, HotspotPrediction, Insight, KpiLive, KpiPoint,
  KpiWindow, Robot, SLA_SIM_MIN, SIM_TIME_SCALE, Snapshot, Station, SubscriptionScope, SuggestedAction, SystemStatus, Task,
  TaskPriority, TaskRequest, TaskSource, TopicName, ValidationResult, ZoneOccupancy,
} from '../../models';

/**
 * In-browser stand-in for the Java Fleet Management Core + AI layer.
 * It is deliberately a black box to the rest of the app: everything leaves through `messages$`
 * (stream), `snapshot()` and the REST-like methods. Replace the transport/REST providers to go live.
 */

const BASE_SPEED = 2.0;        // metres / s (the demo moves faster than the real simulator's 0.05 m/s)
const KPI_WINDOW_MS = 3_600_000 / SIM_TIME_SCALE;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
/** Canonical edge id for a node pair, whichever direction it is travelled (ids follow MAP_EDGES' own ordering). */
const EDGE_ID = new Map<string, string>(MAP_EDGES.flatMap((e) => [[`${e.a}|${e.b}`, e.id], [`${e.b}|${e.a}`, e.id]] as [string, string][]));
const edgeKey = (a: string, b: string) => EDGE_ID.get(`${a}|${b}`) ?? `${a}-${b}`;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

type Phase = 'IDLE' | 'TO_PICKUP' | 'HANDOVER_PICKUP' | 'TRANSIT' | 'HANDOVER_DROP' | 'TO_CHARGE' | 'CHARGING' | 'GOTO';
type Held = null | 'PAUSE' | 'FAULT' | 'MANUAL';
interface Sim { robot: Robot; route: string[]; edgeFrom: string; phase: Phase; timer: number; held: Held; muted: boolean; }
interface Completion {
  id: string; to: string; deliveredAt: number; total: number; wait: number; toPickup: number; transit: number;
  handover: number; saved: number; sla: boolean;
}

@Injectable({ providedIn: 'root' })
export class MockFleetServer {
  readonly messages$ = new Subject<Envelope>();
  readonly drop$ = new Subject<void>();

  private seq = 0;
  private started = false;
  private sims: Sim[] = [];
  private tasks = new Map<string, Task>();
  private insights = new Map<string, Insight>();
  private zones: ZoneOccupancy[] = [];
  private predictions: HotspotPrediction[] = [];
  private blocked = new Set<string>();
  private completions: Completion[] = [];
  private series: KpiPoint[] = [];
  private taskCounter = 1000;
  private insightCounter = 1;
  private skipSeq = false;
  private lastTick = 0;
  private nextTrafficAt = 0;
  private lastActiveEmit = 0;
  private system: SystemStatus = { mode: 'AUTO', hold: false, aiAvailable: true, blockedZones: [] };
  private adjacency = new Map<string, { to: string; w: number; edge: string }[]>();

  // ───────────────────────── lifecycle ─────────────────────────
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const e of MAP_EDGES) {
      const w = dist(NODE_BY_ID[e.a].pos, NODE_BY_ID[e.b].pos);
      this.push(this.adjacency, e.a, { to: e.b, w, edge: e.id });
      this.push(this.adjacency, e.b, { to: e.a, w, edge: e.id });
    }
    this.zones = MAP_EDGES.map((e) => ({ id: e.id, a: e.a, b: e.b, load: 0, blocked: false }));
    const at = (kind: Parameters<typeof idsOfKind>[0], i = 0) => idsOfKind(kind)[i] ?? MAP_NODES[0].id;
    const waypoints = MAP_NODES.filter((n) => !n.kind).map((n) => n.id);
    const starts: [string, string][] = [
      ['R1', at('PHARMACY')], ['R2', waypoints[Math.min(1, waypoints.length - 1)]], ['R3', waypoints[Math.min(2, waypoints.length - 1)]],
      ['R4', at('STORAGE', 1)], ['R5', at('WARD', 1)], ['R6', at('CHARGING')],
    ];
    this.sims = starts.map(([id, node], i) => ({
      robot: {
        id, name: `Robot ${i + 1}`, pos: { ...NODE_BY_ID[node].pos }, heading: 0, speed: 0,
        battery: id === 'R6' ? 55 : Math.round(rnd(68, 96)), status: 'IDLE', taskId: null, route: [], plan: [], ts: Date.now(),
      },
      route: [], edgeFrom: node, phase: id === 'R6' ? 'CHARGING' : 'IDLE', timer: 0, held: null, muted: false,
    }));
    this.seedHistory();
    for (let i = 0; i < 3; i++) this.createTask(this.randomRequest(), { id: 'EHR-DEMO', name: 'Hospital activity' });
    this.nextTrafficAt = Date.now() + 8000;
    this.lastTick = Date.now();

    setInterval(() => this.tick(), 100);
    setInterval(() => this.publishSlow(), 1000);
    setInterval(() => this.publishAi(), 3000);
  }

  private push<K, V>(m: Map<K, V[]>, k: K, v: V) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }

  private publish<T>(topic: TopicName, payload: T): void {
    if (this.skipSeq) { this.seq++; this.skipSeq = false; }
    this.messages$.next({ topic, seq: ++this.seq, ts: Date.now(), payload });
  }

  snapshot(scope: SubscriptionScope): Snapshot {
    const ops = this.isOps(scope);
    const tasks = [...this.tasks.values()].filter((t) => ops || t.requester === scope.userId);
    return {
      seq: this.seq, ts: Date.now(),
      robots: this.robotsFor(scope).map((s) => this.view(s)),
      zones: ops ? this.zones.map((z) => ({ ...z })) : [],
      stations: this.stations(),
      predictions: ops ? [...this.predictions] : [],
      tasks: tasks.map((t) => ({ ...t })),
      insights: [...this.insights.values()].map((i) => ({ ...i })),
      kpi: this.computeKpi(Date.now()),
      system: { ...this.system, blockedZones: [...this.blocked] },
    };
  }

  /** Same shape as GET /api/intel of the Java core, derived from the simulated fleet. */
  intel(): Intel {
    return buildMockIntel({
      robots: this.sims.map((s) => ({ robot: s.robot, phase: s.phase, held: s.held, route: s.route })),
      tasks: [...this.tasks.values()], zones: this.zones, predictions: this.predictions,
      insights: [...this.insights.values()], blocked: [...this.blocked], system: this.system,
      completions: this.completions.map((c) => ({ at: c.deliveredAt, robot: this.tasks.get(c.id)?.robotId ?? null })),
    });
  }

  isOps(scope: SubscriptionScope): boolean { return ['OPERATOR', 'MANAGER', 'ADMIN'].includes(scope.role); }

  robotsFor(scope: SubscriptionScope): Sim[] {
    if (this.isOps(scope)) return this.sims;
    const mine = new Set([...this.tasks.values()].filter((t) => t.requester === scope.userId && t.robotId).map((t) => t.robotId));
    return this.sims.filter((s) => mine.has(s.robot.id));
  }

  // ───────────────────────── mock controls (dev menu) ─────────────────────────
  dropConnections(): void { this.drop$.next(); }
  forceSequenceGap(): void { this.skipSeq = true; }
  muteRobot(id: string, muted: boolean): void { const s = this.sim(id); if (s) s.muted = muted; }
  injectFault(id: string): void {
    const s = this.sim(id);
    if (s) { s.held = 'FAULT'; this.publish('fleet.robots', [this.view(s)]); }
  }
  setAiAvailable(v: boolean): void { this.system.aiAvailable = v; this.publish('system.status', { ...this.system }); }
  robotIds(): string[] { return this.sims.map((s) => s.robot.id); }

  /** One-click demo situations so a first-time user can see the product react without waiting for traffic. */
  runScenario(name: 'rush' | 'corridor' | 'fault' | 'calm'): string {
    const who = { id: 'EHR-DEMO', name: 'Hospital activity' };
    switch (name) {
      case 'rush':
        for (let i = 0; i < 14; i++) this.createTask(this.randomRequest(), who);
        return 'Morning rush: 14 new transport requests arrived.';
      case 'corridor': {
        const names: [string, string] = ['Waypoint_Hallway_North', 'Waypoint_Hallway_Northeast'];
        const id = (MAP_EDGES.find((e) => (e.a === names[0] && e.b === names[1]) || (e.a === names[1] && e.b === names[0])) ?? MAP_EDGES[0]).id;
        this.blocked.add(id);
        setTimeout(() => { if (this.blocked.delete(id)) this.publishSystem(); }, 120_000);
        this.publishSystem();
        return 'The main hallway between the charging area and the kitchen side is blocked for 2 minutes. Robots re-route where they can.';
      }
      case 'fault': {
        const free = this.sims.find((x) => !x.held && x.phase !== 'CHARGING') ?? this.sims[1];
        this.injectFault(free.robot.id);
        return `${free.robot.name} reported a fault.`;
      }
      case 'calm':
        for (const id of [...this.blocked]) this.blocked.delete(id);
        this.system.hold = false; this.system.mode = 'AUTO';
        for (const x of this.sims) if (x.held) { x.held = null; }
        this.publishSystem();
        this.publish('fleet.robots', this.sims.map((x) => this.view(x)));
        return 'Back to normal: blocks cleared, faults reset, dispatching on automatic.';
    }
  }

  // ───────────────────────── REST-like API ─────────────────────────
  validateTask(req: TaskRequest): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (req.from === req.to) errors.push('Pickup and destination must differ.');
    if (this.system.hold) warnings.push('Dispatching is currently on hold — the task will queue until released.');
    if (this.system.mode === 'SEMI_AUTO' && req.priority !== 'STAT') warnings.push('Fleet is in semi-auto mode: only STAT tasks are dispatched automatically.');
    const idle = this.sims.filter((s) => s.phase === 'IDLE' && !s.held).length;
    if (idle === 0) warnings.push('All robots are busy — expect a longer wait before assignment.');
    return { ok: errors.length === 0, errors, warnings };
  }

  createTask(req: TaskRequest, requester: { id: string; name: string }): { taskId: string } {
    const id = `T-${++this.taskCounter}`;
    const task: Task = {
      id, source: req.source, from: req.from, to: req.to, priority: req.priority, status: 'QUEUED', robotId: null,
      requester: requester.id, requesterName: requester.name, item: req.item, notes: req.notes, origin: req.origin,
      createdAt: Date.now(), etaSec: null, version: 1,
    };
    this.tasks.set(id, task);
    this.publish('tasks.events', [{ ...task }]);
    this.trimTasks();
    return { taskId: id };
  }

  command(cmd: CommandRequest, correlationId: string): void {
    setTimeout(() => {
      const reason = this.check(cmd);
      if (reason) { this.ack(correlationId, 'REJECTED', reason); return; }
      this.ack(correlationId, 'ACCEPTED');
      setTimeout(() => {
        this.ack(correlationId, 'EXECUTING');
        this.apply(cmd);
        setTimeout(() => this.ack(correlationId, 'DONE'), 500);
      }, 250);
    }, 150);
  }

  applyInsight(id: string, correlationId: string): void {
    const ins = this.insights.get(id);
    if (!ins || !ins.suggestion || ['DISMISSED', 'EXPIRED', 'RESOLVED', 'ACTION_APPLIED'].includes(ins.state)) {
      setTimeout(() => this.ack(correlationId, 'REJECTED', 'Suggestion is no longer available'), 150);
      return;
    }
    this.command(ins.suggestion.command, correlationId);
    setTimeout(() => this.setInsight(ins, { state: 'ACTION_APPLIED' }), 900);
  }

  dismissInsight(id: string): void { const i = this.insights.get(id); if (i) this.setInsight(i, { state: 'DISMISSED' }); }
  acknowledgeInsight(id: string): void { const i = this.insights.get(id); if (i && i.state === 'NEW') this.setInsight(i, { state: 'ACKNOWLEDGED' }); }

  kpiSeries(window: KpiWindow): KpiPoint[] {
    const cutoff = window === 'SHORT' ? Date.now() - KPI_WINDOW_MS / 2 : window === 'HOUR' ? Date.now() - KPI_WINDOW_MS : 0;
    return this.series.filter((p) => p.t >= cutoff);
  }

  // ───────────────────────── commands ─────────────────────────
  private ack(correlationId: string, state: AckState, reason?: string) {
    const payload: CommandAck = { correlationId, state, reason };
    this.publish('commands.acks', payload);
  }

  private sim(id: string | undefined): Sim | undefined { return this.sims.find((s) => s.robot.id === id); }

  private check(cmd: CommandRequest): string | null {
    const s = this.sim(cmd.targetId);
    const t = cmd.targetId ? this.tasks.get(cmd.targetId) : undefined;
    switch (cmd.type) {
      case 'PAUSE': return !s ? 'Unknown robot' : s.held ? `Robot already held (${s.held})` : null;
      case 'RESUME': return !s ? 'Unknown robot' : s.held !== 'PAUSE' ? 'Robot is not paused' : null;
      case 'ESTOP': return !s ? 'Unknown robot' : s.held === 'FAULT' ? 'Robot already in E-stop' : null;
      case 'RESET': return !s ? 'Unknown robot' : s.held !== 'FAULT' ? 'Robot has no fault to reset' : null;
      case 'TAKE_MANUAL': return !s ? 'Unknown robot' : s.held ? `Robot already held (${s.held})` : null;
      case 'RELEASE_MANUAL': return !s ? 'Unknown robot' : s.held !== 'MANUAL' ? 'Robot is not under manual control' : null;
      case 'CHARGE': return !s ? 'Unknown robot' : s.held || s.robot.taskId ? 'Robot is busy or held' : null;
      case 'GOTO':
        if (!s) return 'Unknown robot';
        if (s.held || s.robot.taskId) return 'Robot is busy or held';
        return NODE_BY_ID[String(cmd.params?.['nodeId'])] ? null : 'Unknown waypoint';
      case 'CANCEL_TASK':
      case 'SET_PRIORITY':
      case 'REASSIGN':
        if (!t) return 'Unknown task';
        if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== t.version) return 'State changed — task was updated by someone else (409)';
        if (['DELIVERED', 'CANCELLED'].includes(t.status)) return `Task already ${t.status.toLowerCase()}`;
        if (cmd.type !== 'SET_PRIORITY' && t.status === 'IN_TRANSIT') return 'Task is already in transit';
        if (cmd.type === 'REASSIGN') {
          const n = this.sim(String(cmd.params?.['robotId']));
          if (!n) return 'Unknown robot';
          if (n.phase !== 'IDLE' || n.held || n.robot.battery < 20) return `${n.robot.name} is not available`;
        }
        return null;
      case 'FLEET_HOLD': return this.system.hold ? 'Dispatching is already on hold' : null;
      case 'FLEET_RESUME': return this.system.hold ? null : 'Dispatching is not on hold';
      case 'SET_MODE': return ['AUTO', 'SEMI_AUTO'].includes(String(cmd.params?.['mode'])) ? null : 'Invalid mode';
      case 'BLOCK_ZONE': return MAP_EDGES.some((e) => e.id === cmd.targetId) ? null : 'Unknown zone';
      case 'UNBLOCK_ZONE': return this.blocked.has(String(cmd.targetId)) ? null : 'Zone is not blocked';
    }
  }

  private apply(cmd: CommandRequest): void {
    const s = this.sim(cmd.targetId);
    const t = cmd.targetId ? this.tasks.get(cmd.targetId) : undefined;
    switch (cmd.type) {
      case 'PAUSE': if (s) s.held = 'PAUSE'; break;
      case 'RESUME': case 'RELEASE_MANUAL': if (s) s.held = null; break;
      case 'ESTOP': if (s) s.held = 'FAULT'; break;
      case 'RESET': if (s) s.held = null; break;
      case 'TAKE_MANUAL': if (s) s.held = 'MANUAL'; break;
      case 'CHARGE': if (s) this.routeTo(s, this.chargerFor(s), 'TO_CHARGE'); break;
      case 'GOTO': if (s) this.routeTo(s, String(cmd.params?.['nodeId']), 'GOTO'); break;
      case 'CANCEL_TASK':
        if (t) { this.releaseRobot(t); this.updateTask(t, { status: 'CANCELLED', robotId: null, etaSec: null }); }
        break;
      case 'SET_PRIORITY': if (t) this.updateTask(t, { priority: String(cmd.params?.['priority']) as TaskPriority }); break;
      case 'REASSIGN': {
        const n = this.sim(String(cmd.params?.['robotId']));
        if (t && n) { this.releaseRobot(t); this.assign(t, n); }
        break;
      }
      case 'FLEET_HOLD': this.system.hold = true; this.publish('system.status', { ...this.system }); break;
      case 'FLEET_RESUME': this.system.hold = false; this.publish('system.status', { ...this.system }); break;
      case 'SET_MODE': this.system.mode = String(cmd.params?.['mode']) as 'AUTO' | 'SEMI_AUTO'; this.publish('system.status', { ...this.system }); break;
      case 'BLOCK_ZONE': {
        const id = String(cmd.targetId);
        this.blocked.add(id);
        const secs = Number(cmd.params?.['durationSec'] ?? 120);
        setTimeout(() => { if (this.blocked.delete(id)) this.publishSystem(); }, secs * 1000);
        this.publishSystem();
        break;
      }
      case 'UNBLOCK_ZONE': this.blocked.delete(String(cmd.targetId)); this.publishSystem(); break;
    }
    if (s) this.publish('fleet.robots', [this.view(s)]);
  }

  private publishSystem() { this.system.blockedZones = [...this.blocked]; this.publish('system.status', { ...this.system }); }

  // ───────────────────────── simulation ─────────────────────────
  private tick(): void {
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;

    for (const s of this.sims) this.step(s, dt);
    this.dispatch();

    if (now >= this.nextTrafficAt) {
      this.createTask(this.randomRequest(), { id: 'EHR-DEMO', name: 'Hospital activity' });
      this.nextTrafficAt = now + rnd(9000, 16000);
    }
    this.publish('fleet.robots', this.sims.filter((s) => !s.muted).map((s) => this.view(s)));

    if (now - this.lastActiveEmit > 2000) {
      this.lastActiveEmit = now;
      const active = [...this.tasks.values()].filter((t) => ['ASSIGNED', 'TO_PICKUP', 'IN_TRANSIT'].includes(t.status));
      for (const t of active) t.etaSec = this.eta(t);
      if (active.length) this.publish('tasks.events', active.map((t) => ({ ...t })));
    }
  }

  private view(s: Sim): Robot {
    const t = s.robot.taskId ? this.tasks.get(s.robot.taskId) : undefined;
    const plan = t && (s.phase === 'TO_PICKUP' || s.phase === 'HANDOVER_PICKUP') ? this.path(t.from, t.to) : [];
    return { ...s.robot, pos: { ...s.robot.pos }, route: [...s.route], plan, ts: Date.now() };
  }

  private step(s: Sim, dt: number): void {
    const r = s.robot;
    if (s.held) {
      r.speed = 0;
      r.status = s.held === 'FAULT' ? 'FAULT' : s.held === 'PAUSE' ? 'PAUSED' : 'MANUAL_OVERRIDE';
      return;
    }
    switch (s.phase) {
      case 'IDLE':
        r.speed = 0; r.status = 'IDLE';
        if (r.battery < 30 && !this.system.hold) this.routeTo(s, this.chargerFor(s), 'TO_CHARGE');
        return;
      case 'CHARGING':
        r.speed = 0; r.status = 'CHARGING'; r.battery = Math.min(100, r.battery + 2.2 * dt);
        if (r.battery >= 95) s.phase = 'IDLE';
        return;
      case 'HANDOVER_PICKUP': case 'HANDOVER_DROP':
        r.speed = 0; s.timer -= dt;
        if (s.timer <= 0) this.finishHandover(s);
        return;
      default:
        this.move(s, dt);
    }
  }

  private move(s: Sim, dt: number): void {
    const r = s.robot;
    if (!s.route.length) { this.onRouteEnd(s); return; }
    const target = NODE_BY_ID[s.route[0]].pos;
    const d = dist(r.pos, target);
    const ux = (target.x - r.pos.x) / (d || 1);
    const uy = (target.y - r.pos.y) / (d || 1);
    let slow = false;
    for (const o of this.sims) {
      if (o === s) continue;
      const dd = dist(o.robot.pos, r.pos);
      if (dd < 4 && ((o.robot.pos.x - r.pos.x) * ux + (o.robot.pos.y - r.pos.y) * uy) / (dd || 1) > 0.6) { slow = true; break; }
    }
    const speed = BASE_SPEED * (slow ? 0.3 : 1);
    const stepLen = speed * dt;
    r.heading = Math.atan2(uy, ux);
    r.speed = speed;
    r.battery = Math.max(0, r.battery - 0.18 * dt);
    if (stepLen >= d) {
      r.pos = { ...target };
      s.edgeFrom = s.route.shift()!;
      if (!s.route.length) this.onRouteEnd(s);
    } else {
      r.pos = { x: r.pos.x + ux * stepLen, y: r.pos.y + uy * stepLen };
    }
    const carrying = s.phase === 'TRANSIT';
    r.status = slow && (s.phase === 'TO_PICKUP' || carrying) ? 'WAITING'
      : s.phase === 'TO_PICKUP' ? 'EN_ROUTE_TO_PICKUP' : carrying ? 'CARRYING' : 'IDLE';
  }

  private onRouteEnd(s: Sim): void {
    s.robot.speed = 0;
    switch (s.phase) {
      case 'TO_PICKUP': s.phase = 'HANDOVER_PICKUP'; s.timer = 1.5; break;
      case 'TRANSIT': s.phase = 'HANDOVER_DROP'; s.timer = 1.5; break;
      case 'TO_CHARGE': s.phase = 'CHARGING'; break;
      default: s.phase = 'IDLE';
    }
  }

  private finishHandover(s: Sim): void {
    const t = s.robot.taskId ? this.tasks.get(s.robot.taskId) : undefined;
    if (!t) { s.phase = 'IDLE'; return; }
    if (s.phase === 'HANDOVER_PICKUP') {
      s.route = this.path(s.edgeFrom, t.to);
      s.phase = 'TRANSIT';
      s.robot.status = 'CARRYING';
      this.updateTask(t, { status: 'IN_TRANSIT', pickedAt: Date.now() });
    } else {
      this.deliver(t, s);
    }
  }

  private deliver(t: Task, s: Sim): void {
    const now = Date.now();
    const k = SIM_TIME_SCALE / 1000;
    const total = (now - t.createdAt) * k;
    const wait = ((t.assignedAt ?? now) - t.createdAt) * k;
    const transit = Math.max(0, (now - (t.pickedAt ?? now)) * k - 1.5 * SIM_TIME_SCALE);
    const toPickup = Math.max(0, ((t.pickedAt ?? now) - (t.assignedAt ?? now)) * k - 1.5 * SIM_TIME_SCALE);
    this.completions.push({
      id: t.id, to: t.to, deliveredAt: now, total, wait, toPickup, transit, handover: 3 * SIM_TIME_SCALE,
      saved: Math.round((transit / 60) * 2 + 4), sla: total / 60 <= SLA_SIM_MIN[t.priority],
    });
    s.phase = 'IDLE';
    s.robot.taskId = null;
    s.robot.status = 'IDLE';
    this.updateTask(t, { status: 'DELIVERED', deliveredAt: now, etaSec: 0 });
  }

  private releaseRobot(t: Task): void {
    const s = this.sim(t.robotId ?? undefined);
    if (!s) return;
    s.robot.taskId = null;
    s.phase = s.route.length ? 'GOTO' : 'IDLE';
    s.route = s.route.slice(0, 1);
    if (s.phase === 'IDLE') s.robot.speed = 0;
  }

  /** A free charging station (nearest first); the least crowded one when all are taken. */
  private chargerFor(s: Sim): string {
    const taken = new Map<string, number>();
    for (const o of this.sims) {
      if (o === s) continue;
      const target = o.phase === 'TO_CHARGE' && o.route.length ? o.route[o.route.length - 1] : o.phase === 'CHARGING' ? o.edgeFrom : null;
      if (target) taken.set(target, (taken.get(target) ?? 0) + 1);
    }
    const from = NODE_BY_ID[s.route.length ? s.route[0] : s.edgeFrom]?.pos ?? s.robot.pos;
    return [...idsOfKind('CHARGING')].sort((a, b) => (taken.get(a) ?? 0) - (taken.get(b) ?? 0) || dist(from, NODE_BY_ID[a].pos) - dist(from, NODE_BY_ID[b].pos))[0];
  }

  private routeTo(s: Sim, node: string, phase: Phase): void {
    const from = s.route.length ? s.route[0] : s.edgeFrom;
    s.route = s.route.length ? [s.route[0], ...this.path(from, node)] : this.path(from, node);
    s.phase = s.route.length ? phase : phase === 'TO_CHARGE' ? 'CHARGING' : 'IDLE';
  }

  private dispatch(): void {
    if (this.system.hold) return;
    const rank: Record<TaskPriority, number> = { STAT: 0, URGENT: 1, ROUTINE: 2 };
    const queued = [...this.tasks.values()].filter((t) => t.status === 'QUEUED')
      .sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt - b.createdAt);
    for (const t of queued) {
      if (this.system.mode === 'SEMI_AUTO' && t.priority !== 'STAT') continue;
      let best: Sim | null = null;
      let bestD = Infinity;
      for (const s of this.sims) {
        if (s.phase !== 'IDLE' || s.held || s.robot.battery < 25) continue;
        const d = this.pathLen(s.edgeFrom, t.from);
        if (d < bestD) { best = s; bestD = d; }
      }
      if (best) this.assign(t, best);
    }
  }

  private assign(t: Task, s: Sim): void {
    s.robot.taskId = t.id;
    s.route = this.path(s.edgeFrom, t.from);
    s.phase = s.route.length ? 'TO_PICKUP' : 'HANDOVER_PICKUP';
    s.timer = 1.5;
    this.updateTask(t, { status: 'TO_PICKUP', robotId: s.robot.id, assignedAt: Date.now() });
  }

  private updateTask(t: Task, patch: Partial<Task>): void {
    Object.assign(t, patch, { version: t.version + 1 });
    t.etaSec = ['ASSIGNED', 'TO_PICKUP', 'IN_TRANSIT'].includes(t.status) ? this.eta(t) : t.etaSec;
    this.publish('tasks.events', [{ ...t }]);
  }

  private eta(t: Task): number | null {
    const s = this.sim(t.robotId ?? undefined);
    if (!s) return null;
    let d = 0;
    let cur = s.robot.pos;
    for (const n of s.route) { d += dist(cur, NODE_BY_ID[n].pos); cur = NODE_BY_ID[n].pos; }
    if (t.status === 'TO_PICKUP') d += this.pathLen(s.route.at(-1) ?? s.edgeFrom, t.to, t.from);
    return Math.round((d / BASE_SPEED) * SIM_TIME_SCALE);
  }

  private trimTasks(): void {
    const done = [...this.tasks.values()].filter((t) => ['DELIVERED', 'CANCELLED'].includes(t.status)).sort((a, b) => a.createdAt - b.createdAt);
    while (done.length > 120) this.tasks.delete(done.shift()!.id);
  }

  private stations(): Station[] {
    return STATION_NODES.map((n) => ({
      id: n.id, name: n.name, kind: n.kind!, pos: n.pos,
      queue: [...this.tasks.values()].filter((t) => t.status === 'QUEUED' && t.from === n.id).length,
    }));
  }

  // ───────────────────────── routing ─────────────────────────
  private path(from: string, to: string): string[] {
    return this.dijkstra(from, to, this.blocked) ?? this.dijkstra(from, to, new Set()) ?? [];
  }

  private pathLen(from: string, to: string, via?: string): number {
    const leg = (a: string, b: string) => {
      let d = 0;
      let cur = a;
      for (const n of this.path(a, b)) { d += dist(NODE_BY_ID[cur].pos, NODE_BY_ID[n].pos); cur = n; }
      return d;
    };
    return via ? leg(from, via) + leg(via, to) : leg(from, to);
  }

  private dijkstra(from: string, to: string, avoid: Set<string>): string[] | null {
    if (from === to) return [];
    const d = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const open = new Set<string>([from]);
    while (open.size) {
      let u = '';
      let best = Infinity;
      for (const n of open) if ((d.get(n) ?? Infinity) < best) { best = d.get(n)!; u = n; }
      open.delete(u);
      if (u === to) break;
      for (const e of this.adjacency.get(u) ?? []) {
        if (avoid.has(e.edge)) continue;
        const nd = best + e.w;
        if (nd < (d.get(e.to) ?? Infinity)) { d.set(e.to, nd); prev.set(e.to, u); open.add(e.to); }
      }
    }
    if (!prev.has(to)) return null;
    const out: string[] = [];
    for (let n: string | undefined = to; n && n !== from; n = prev.get(n)) out.unshift(n);
    return out;
  }

  // ───────────────────────── slow topics, AI layer ─────────────────────────
  private publishSlow(): void {
    for (const z of this.zones) {
      const n = this.sims.filter((s) => s.route.length && s.phase !== 'IDLE' && edgeKey(s.edgeFrom, s.route[0]) === z.id).length;
      z.load = Math.round((n / 2) * 100) / 100;
      z.blocked = this.blocked.has(z.id);
    }
    this.publish('fleet.zones', { zones: this.zones.map((z) => ({ ...z })), stations: this.stations().map(({ id, queue }) => ({ id, queue })) });
    this.publish('system.status', { ...this.system, blockedZones: [...this.blocked] });
  }

  private publishAi(): void {
    const kpi = this.computeKpi(Date.now());
    this.series.push(kpi.point);
    if (this.series.length > 1500) this.series.shift();
    this.publish('kpi.live', kpi);
    if (!this.system.aiAvailable) return;
    this.predictions = this.predict();
    this.publish('ai.predictions', { generatedAt: Date.now(), items: this.predictions });
    this.manageInsights();
  }

  private predict(): HotspotPrediction[] {
    const windows: [HorizonMin, number, number][] = [[5, 0, 50], [15, 50, 150], [30, 150, 300]];
    const counts = new Map<string, number>();
    const add = (edge: string, h: HorizonMin, w: number) => counts.set(`${h}|${edge}`, (counts.get(`${h}|${edge}`) ?? 0) + w);
    const walk = (startNode: string, nodes: string[], t0: number, weight: number, firstPos?: { x: number; y: number }) => {
      let t = t0;
      let prev = startNode;
      let cur = firstPos ?? NODE_BY_ID[startNode].pos;
      for (const n of nodes) {
        const edge = edgeKey(prev, n);
        for (const [h, lo, hi] of windows) if (t >= lo && t < hi && !this.blocked.has(edge)) add(edge, h, weight);
        t += dist(cur, NODE_BY_ID[n].pos) / BASE_SPEED;
        cur = NODE_BY_ID[n].pos; prev = n;
      }
    };
    for (const s of this.sims) {
      if (s.held || !s.route.length || s.phase === 'IDLE') continue;
      const task = s.robot.taskId ? this.tasks.get(s.robot.taskId) : undefined;
      let nodes = s.route;
      if (task && s.phase === 'TO_PICKUP') nodes = [...s.route, ...this.path(task.from, task.to)];
      walk(s.edgeFrom, nodes, 0, 1, s.robot.pos);
    }
    for (const t of this.tasks.values()) {
      if (t.status !== 'QUEUED') continue;
      walk(t.from, this.path(t.from, t.to), 40, 0.6);
    }
    const out: HotspotPrediction[] = [];
    for (const [key, c] of counts) {
      const [hs, edge] = key.split('|');
      const load = c / 2;
      if (load < 1) continue;
      const z = this.zones.find((zz) => zz.id === edge)!;
      const a = NODE_BY_ID[z.a].pos;
      const b = NODE_BY_ID[z.b].pos;
      out.push({
        id: `p-${hs}-${edge}`, zoneId: edge, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, radius: 3 + Math.min(load, 2) * 1.2,
        horizonMin: Number(hs) as HorizonMin, severity: Math.min(1, load / 2), confidence: Math.round((0.6 + Math.min(0.35, load * 0.1)) * 100) / 100,
      });
    }
    return out;
  }

  private zoneName(id: string): string {
    const z = this.zones.find((x) => x.id === id)!;
    return `${stationName(z.a)} ↔ ${stationName(z.b)}`;
  }

  private manageInsights(): void {
    const now = Date.now();
    const open = (i: Insight) => !['DISMISSED', 'EXPIRED', 'RESOLVED', 'ACTION_APPLIED'].includes(i.state);
    for (const i of this.insights.values()) {
      if (!open(i) && !(i.state === 'ACTION_APPLIED' && now > i.validUntil)) continue;
      if (now > i.validUntil) { this.setInsight(i, { state: i.state === 'ACTION_APPLIED' ? 'RESOLVED' : 'EXPIRED' }); continue; }
      if (i.zoneId && now - i.createdAt > 8000 && !this.predictions.some((p) => p.zoneId === i.zoneId)) this.setInsight(i, { state: 'RESOLVED' });
    }
    const active = [...this.insights.values()].filter(open);
    if (active.length >= 6) return;

    const hot = this.predictions.filter((p) => p.horizonMin <= 15 && p.severity >= 0.75).sort((a, b) => b.severity - a.severity);
    for (const p of hot) {
      const covered = [...this.insights.values()].some((i) => i.zoneId === p.zoneId && (open(i) || now - i.createdAt < 25_000));
      if (covered) continue;
      const mid = p.center;
      const nearest = STATION_NODES.filter((n) => n.kind !== 'CHARGING').sort((a, b) => dist(a.pos, mid) - dist(b.pos, mid))[0];
      const idle = this.sims.filter((s) => s.phase === 'IDLE' && !s.held && s.robot.battery > 30 && s.edgeFrom !== nearest.id)
        .sort((a, b) => this.pathLen(a.edgeFrom, nearest.id) - this.pathLen(b.edgeFrom, nearest.id))[0];
      const impact = Math.round(p.severity * 4.4 * 10) / 10;
      const suggestion: SuggestedAction = idle
        ? { id: `sg-${this.insightCounter}`, label: `Pre-position ${idle.robot.name} near ${nearest.name}`, impactMin: impact,
            command: { type: 'GOTO' as const, targetId: idle.robot.id, params: { nodeId: nearest.id }, reason: 'AI suggestion' } }
        : { id: `sg-${this.insightCounter}`, label: `Divert new dispatches around ${this.zoneName(p.zoneId)} for 2 min`, impactMin: impact,
            command: { type: 'BLOCK_ZONE' as const, targetId: p.zoneId, params: { durationSec: 120 }, reason: 'AI suggestion' } };
      const ins: Insight = {
        id: `INS-${this.insightCounter++}`, severity: p.severity >= 1 ? 'CRITICAL' : 'WARNING',
        title: `Predicted congestion: ${this.zoneName(p.zoneId)}`, zoneId: p.zoneId, stationId: nearest.id,
        etaMin: p.horizonMin, confidence: p.confidence, affectedTasks: Math.max(2, Math.round(p.severity * 5)),
        state: 'ACTION_PROPOSED', createdAt: now, validUntil: now + p.horizonMin * 10_000 + 30_000, suggestion,
        staffMessage: `Deliveries near ${nearest.name} may be delayed by about ${Math.max(1, Math.round(impact))} min.`,
      };
      this.insights.set(ins.id, ins);
      this.publish('ai.insights', { ...ins });
      break;
    }

    for (const st of this.stations()) {
      if (st.queue < 3) continue;
      const exists = [...this.insights.values()].some((i) => i.stationId === st.id && i.zoneId === null && (open(i) || now - i.createdAt < 25_000));
      if (exists) continue;
      const ins: Insight = {
        id: `INS-${this.insightCounter++}`, severity: 'INFO', title: `${st.name} pickup queue growing (${st.queue} waiting)`, zoneId: null,
        stationId: st.id, etaMin: 5, confidence: 0.72, affectedTasks: st.queue, state: 'NEW', createdAt: now,
        validUntil: now + 45_000, suggestion: null, staffMessage: `Pickups at ${st.name} are queuing — expect a short wait.`,
      };
      this.insights.set(ins.id, ins);
      this.publish('ai.insights', { ...ins });
      break;
    }
  }

  private setInsight(i: Insight, patch: Partial<Insight>): void {
    Object.assign(i, patch);
    this.publish('ai.insights', { ...i });
  }

  // ───────────────────────── KPI ─────────────────────────
  private computeKpi(at: number): KpiLive {
    const inWin = this.completions.filter((c) => c.deliveredAt > at - KPI_WINDOW_MS && c.deliveredAt <= at);
    const prev = this.completions.filter((c) => c.deliveredAt > at - 2 * KPI_WINDOW_MS && c.deliveredAt <= at - KPI_WINDOW_MS);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : 0);
    const totals = inWin.map((c) => c.total);
    const saved = this.completions.filter((c) => c.deliveredAt <= at).reduce((a, c) => a + c.saved, 0);
    const byStation = new Map<string, number[]>();
    for (const c of inWin) this.push(byStation, c.to, c.total);
    const point: KpiPoint = {
      t: at, avgSec: Math.round(mean(totals)), p90Sec: Math.round(p90(totals)), tph: inWin.length, saved,
      wait: Math.round(mean(inWin.map((c) => c.wait))), toPickup: Math.round(mean(inWin.map((c) => c.toPickup))),
      transit: Math.round(mean(inWin.map((c) => c.transit))), handover: Math.round(mean(inWin.map((c) => c.handover))),
    };
    return {
      avgTaskSec: point.avgSec, p90TaskSec: point.p90Sec, tasksPerHour: inWin.length, staffMinSaved: saved,
      slaMet: inWin.length ? inWin.filter((c) => c.sla).length / inWin.length : 1,
      prev: { avgTaskSec: prev.length >= 5 ? Math.round(mean(prev.map((c) => c.total))) : null, tasksPerHour: prev.length >= 5 ? prev.length : null },
      byStation: [...byStation].map(([stationId, xs]) => ({ stationId, count: xs.length, avgSec: Math.round(mean(xs)) })).sort((a, b) => b.count - a.count),
      computedAt: at, methodologyVersion: 'mock-v1 (walk-time + handover estimate)', point,
    };
  }

  private seedHistory(): void {
    const now = Date.now();
    const sources = STATION_NODES.filter((n) => n.kind !== 'CHARGING');
    for (let i = 0; i < 120; i++) {
      const wait = rnd(8, 80), toPickup = rnd(50, 170), transit = rnd(70, 230), handover = 3 * SIM_TIME_SCALE;
      const total = wait + toPickup + transit + handover;
      const prio = pick<TaskPriority>(['STAT', 'URGENT', 'ROUTINE', 'ROUTINE']);
      this.completions.push({
        id: `H-${i}`, to: pick(sources).id, deliveredAt: now - rnd(8_000, 1_800_000), total, wait, toPickup, transit, handover,
        saved: Math.round((transit / 60) * 2 + 4), sla: total / 60 <= SLA_SIM_MIN[prio],
      });
    }
    this.completions.sort((a, b) => a.deliveredAt - b.deliveredAt);
    for (let i = 400; i >= 1; i--) this.series.push(this.computeKpi(now - i * 3000).point);
  }

  // ───────────────────────── traffic generator ─────────────────────────
  randomRequest(): TaskRequest {
    const source = pick<TaskSource>(['PHARMACY', 'PHARMACY', 'KITCHEN', 'LAUNDRY', 'STORAGE', 'WARD', 'WARD']);
    const wards = [...WARD_IDS, ...idsOfKind('OR')];
    const of = (...k: Parameters<typeof idsOfKind>) => idsOfKind(...k);
    let from: string, to: string, item: string;
    switch (source) {
      case 'PHARMACY': from = pick(of('PHARMACY')); to = pick(wards); item = pick(['Medication', 'IV bags', 'Controlled substance']); break;
      case 'KITCHEN': from = pick(of('KITCHEN')); to = pick(WARD_IDS); item = pick(['Meal trays', 'Special diet meals', 'Beverages']); break;
      case 'LAUNDRY': from = pick(of('LAUNDRY')); to = pick(wards); item = pick(['Clean linen', 'Scrubs', 'Blankets']); break;
      case 'STORAGE': from = pick(of('STORAGE')); to = pick(wards); item = pick(['Medical supplies', 'Sterile supplies', 'Equipment']); break;
      default: from = pick(wards); to = pick(of('LAUNDRY', 'WASTE', 'PHARMACY', 'STORAGE')); item = pick(['Linen return', 'Waste collection', 'Supplies request', 'Equipment return']);
    }
    return { source, from, to, priority: pick<TaskPriority>(['ROUTINE', 'ROUTINE', 'ROUTINE', 'URGENT', 'STAT']), item, origin: 'REAL' };
  }

  nodeCount(): number { return MAP_NODES.length; }
}
