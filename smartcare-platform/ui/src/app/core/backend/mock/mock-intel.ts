import {
  DetectorState, IntelDemandForecast, Intel, IntelCandidate, IntelCoordination, IntelCorridor, IntelEnergyRobot, IntelPoint, IntelQueueItem, BatteryLevel,
} from '../../intel.models';
import { MAP_EDGES, NODE_BY_ID, idsOfKind, stationName } from '../../map-data';
import { HotspotPrediction, Insight, Robot, SIM_TIME_SCALE, SystemStatus, Task, ZoneOccupancy } from '../../models';

/** Plain data handed over by MockFleetServer (keeps this file independent of the simulator internals). */
export interface MockIntelInput {
  robots: { robot: Robot; phase: string; held: null | 'PAUSE' | 'FAULT' | 'MANUAL'; route: string[] }[];
  tasks: Task[]; zones: ZoneOccupancy[]; predictions: HotspotPrediction[]; insights: Insight[];
  blocked: string[]; system: SystemStatus; completions: { at: number; robot: string | null }[];
}

// Policy numbers mirror application.yml of the Java core.
const POLICY = { critical: 15, low: 30, target: 90, minRelease: 60, opportunisticBelow: 60, reserve: 8 };
const BASE = { STAT: 100, URGENT: 50, ROUTINE: 20 } as const;
const AGING_PER_MIN = 5, AGING_CAP = 60, SPEED = 3.6;
const fHist: { t: number; actual: number; predicted: number }[] = [];
let fLastT = 0, fLastCount = 0;
const history: { t: number; avail: number; bat: number; wait: number; cong: number }[] = [];

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const edgeName = (id: string) => { const e = MAP_EDGES.find((x) => x.id === id); return e ? [stationName(e.a), stationName(e.b)] as const : [id, id] as const; };
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Mock of the core's learned demand model: smoothed arrivals per station over simulated minutes. */
function mockForecast(d: MockIntelInput, now: number): IntelDemandForecast {
  const simMin = (ms: number) => (ms * SIM_TIME_SCALE) / 60000;
  const per = new Map<string, { cur: number; prev: number }>();
  for (const t of d.tasks) {
    const age = simMin(now - t.createdAt);
    if (age > 20) continue;
    const e = per.get(t.from) ?? { cur: 0, prev: 0 };
    if (age <= 10) e.cur++; else e.prev++;
    per.set(t.from, e);
  }
  const e10 = (x: { cur: number; prev: number }) => Math.round((0.7 * x.cur + 0.3 * x.prev) * 10) / 10;
  const total = [...per.values()].reduce((a, x) => a + e10(x), 0);
  const created = d.tasks.length;
  if (now - fLastT > 4000) {
    const actual = Math.max(0, created - fLastCount), predicted = fHist.length ? fHist[fHist.length - 1].actual * 0.7 + (total / 10) * 0.3 : total / 10;
    if (fLastT) fHist.push({ t: now, actual, predicted });
    while (fHist.length > 60) fHist.shift();
    fLastT = now; fLastCount = created;
  }
  let abs = 0, naive = 0, n = 0;
  for (let i = 1; i < fHist.length; i++) { abs += Math.abs(fHist[i].actual - fHist[i].predicted); naive += Math.abs(fHist[i].actual - fHist[i - 1].actual); n++; }
  const mae = n ? abs / n : 0, nmae = n ? naive / n : 0;
  const ready = fHist.length >= 5;
  const level: IntelDemandForecast['demandLevel'] = !ready ? 'LEARNING' : total >= 2 ? 'HIGH' : total >= 1 ? 'NORMAL' : 'LOW';
  const idle = d.robots.filter((s) => s.phase === 'IDLE' && !s.held);
  const stations = [...per.entries()].sort((a, b) => e10(b[1]) - e10(a[1])).slice(0, 8).map(([id, x]) => ({
    id, name: stationName(id), expected10: e10(x), expected30: Math.round(e10(x) * 2.4 * 10) / 10,
    robots: idle.filter((s) => s.route.length === 0 && s.robot.pos && NODE_BY_ID[id] && Math.hypot(s.robot.pos.x - NODE_BY_ID[id].pos.x, s.robot.pos.y - NODE_BY_ID[id].pos.y) < 4).map((s) => s.robot.name),
  }));
  const decisions: IntelDemandForecast['decisions'] = [];
  if (ready && stations.length) {
    const top = stations[0];
    decisions.push({ type: 'PRE_POSITION', text: `A free robot waits at ${top.name} — about ${top.expected10} orders expected in 10 min`, ageSec: 12 });
  }
  return {
    enabled: true, ready, model: 'Online demand model: smoothed level + hour-of-day profile', bucketSeconds: 4, trainedBuckets: fHist.length, minBuckets: 5,
    mae: Math.round(mae * 100) / 100, naiveMae: Math.round(nmae * 100) / 100, improvementPct: nmae > 0 ? Math.round((100 * (nmae - mae)) / nmae) : 0,
    expected10: Math.round(total * 10) / 10, expected30: Math.round(total * 2.4 * 10) / 10, busyThreshold: 2, demandLevel: level, prePosition: true,
    stations, history: fHist.map((h) => ({ t: h.t, a: h.actual, b: Math.round(h.predicted * 100) / 100 })), decisions,
    counters: { PRE_POSITION: decisions.length, KEPT_READY: 0, RELEASED_EARLY: 0 },
  };
}

export function buildMockIntel(d: MockIntelInput): Intel {
  const now = Date.now();
  const scale = SIM_TIME_SCALE;                      // simulated seconds per real second
  const winMs = 600_000 / scale;
  const recent = (id: string) => d.completions.filter((c) => c.robot === id && c.at > now - winMs).length;
  const rs = d.robots;
  const isFree = (s: MockIntelInput['robots'][number]) => (s.phase === 'IDLE' || (s.phase === 'CHARGING' && s.robot.battery >= POLICY.minRelease)) && !s.held && s.robot.battery > POLICY.critical;
  const status = (s: MockIntelInput['robots'][number]) => s.robot.status;

  // ───── dispatch ─────
  const queued = d.tasks.filter((t) => t.status === 'QUEUED');
  const pts = (t: Task) => { const age = ((now - t.createdAt) * scale) / 60000; return { base: BASE[t.priority], aging: Math.min(AGING_CAP, age * AGING_PER_MIN) }; };
  queued.sort((a, b) => { const pa = pts(a), pb = pts(b); return pb.base + pb.aging - (pa.base + pa.aging) || a.createdAt - b.createdAt; });
  const queue: IntelQueueItem[] = queued.slice(0, 8).map((t) => {
    const p = pts(t), total = p.base + p.aging, from = NODE_BY_ID[t.from]?.pos;
    const cands: IntelCandidate[] = rs.map((s) => {
      const eta = from ? r1((dist(s.robot.pos, from) * 1.3) / SPEED) : null;
      const rec = recent(s.robot.id);
      let reason: string | null = null;
      if (s.held === 'MANUAL') reason = 'manual control'; else if (s.held) reason = 'paused / fault';
      else if (s.phase !== 'IDLE' && s.phase !== 'CHARGING') reason = 'busy';
      else if (s.robot.battery <= POLICY.critical) reason = 'battery critical';
      else if (s.phase === 'CHARGING' && s.robot.battery < POLICY.minRelease) reason = `charging (< ${POLICY.minRelease} %)`;
      const raw = (eta ?? 0) + 25 * rec + 0.6 * (100 - s.robot.battery);
      return { robot: s.robot.name, eligible: reason === null, reason, etaToPickupSec: eta, battery: r1(s.robot.battery), recentTasks: rec, cost: r1(raw / (total / 20)) };
    }).sort((a, b) => Number(!a.eligible) - Number(!b.eligible) || (a.cost ?? 1e9) - (b.cost ?? 1e9)).slice(0, 5);
    return {
      id: t.id, priority: t.priority, item: t.item, from: t.from, to: t.to, fromName: stationName(t.from), toName: stationName(t.to),
      ageSec: Math.round(((now - t.createdAt) * scale) / 1000), basePoints: p.base, agingPoints: r1(p.aging), points: r1(total), candidates: cands,
    };
  });
  const loads = rs.map((s) => ({ robot: s.robot.name, recentTasks: recent(s.robot.id), status: status(s), busy: s.phase !== 'IDLE' && s.phase !== 'CHARGING', battery: Math.round(s.robot.battery) }));
  const counts = loads.map((l) => l.recentTasks), mean = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const std = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, counts.length));
  const balance = mean < 0.5 ? 100 : Math.max(0, 100 - (100 * std) / Math.max(1, mean));
  const busyN = loads.filter((l) => l.busy).length;

  // ───── energy ─────
  const energyRobots: IntelEnergyRobot[] = rs.map((s) => {
    const b = s.robot.battery;
    const level: BatteryLevel = b <= POLICY.critical ? 'CRITICAL' : b < POLICY.low ? 'LOW' : b >= POLICY.target ? 'FULL' : 'OK';
    const range = Math.max(0, (b - POLICY.critical - POLICY.reserve) / 0.04);
    const charging = s.phase === 'CHARGING';
    let action = 'Ready for work';
    if (charging) action = b >= POLICY.target ? 'Full — will be released' : b >= POLICY.minRelease ? 'Charging — can be released if work waits' : `Charging to ${POLICY.minRelease} % minimum`;
    else if (s.phase === 'TO_CHARGE') action = 'Driving to charger';
    else if (s.phase !== 'IDLE') action = b <= POLICY.critical ? 'On task — battery critical' : `On task — range ${Math.round(range)} m`;
    else if (b <= POLICY.critical) action = 'Critical — no new work, charging';
    else if (b < POLICY.low) action = 'Low — sent to charger when idle';
    else if (b < POLICY.opportunisticBelow) action = 'Tops up when no work is waiting';
    return { robot: s.robot.name, battery: r1(b), level, charging, available: isFree(s), rangeM: Math.round(range), action, online: true, consumptionZ: 0, status: status(s) };
  });
  const availableNow = energyRobots.filter((r) => r.available).length;
  const atCharger = rs.filter((s) => s.phase === 'CHARGING').map((s) => s.robot.name);
  const incoming = rs.filter((s) => s.phase === 'TO_CHARGE').map((s) => s.robot.name);
  const chargerRows = idsOfKind('CHARGING').map((id) => {
    const pos = NODE_BY_ID[id].pos;
    const here = rs.filter((s) => s.phase === 'CHARGING' && Math.hypot(s.robot.pos.x - pos.x, s.robot.pos.y - pos.y) < 1.5).map((s) => s.robot.name);
    const coming = rs.filter((s) => s.phase === 'TO_CHARGE' && s.route[s.route.length - 1] === id).map((s) => s.robot.name);
    return { id, name: NODE_BY_ID[id].name, capacity: 1, occupied: here.length, robots: here, incoming: coming };
  });
  const avgBat = Math.round(rs.reduce((a, s) => a + s.robot.battery, 0) / Math.max(1, rs.length));

  // ───── traffic ─────
  const nameOf = (id: string) => NODE_BY_ID[id]?.name ?? id;
  const coordination: IntelCoordination[] = rs.map((s) => {
    const active = s.phase !== 'IDLE' && s.phase !== 'CHARGING';
    const r = s.robot;
    return {
      robot: r.name, status: r.status, mission: active ? (s.phase === 'TO_CHARGE' ? 'CHARGE' : 'TASK') : null, taskId: r.taskId,
      at: null, heading: active && s.route.length ? nameOf(s.route[s.route.length - 1]) : null, released: Math.min(2, s.route.length), remaining: s.route.length,
      waitingFor: r.status === 'WAITING' ? 'another robot' : null, waitSec: 0, waitNode: r.status === 'WAITING' && s.route.length ? nameOf(s.route[0]) : null,
    };
  });
  const waiting = coordination.filter((c) => c.waitingFor).length;
  const bn = new Map<string, string[]>();
  for (const c of coordination) if (c.waitNode) bn.set(c.waitNode, [...(bn.get(c.waitNode) ?? []), c.robot]);
  const slow: IntelCorridor[] = d.zones.filter((z) => z.load > 0 && !z.blocked).map((z) => {
    const [from, to] = edgeName(z.id);
    const a = NODE_BY_ID[z.a].pos, b = NODE_BY_ID[z.b].pos;
    const free = dist(a, b) / SPEED, slowdown = 100 * 0.35 * z.load;
    return { id: z.id, from, to, freeSec: r1(free), learnedSec: r1(free * (1 + slowdown / 100)), slowdownPct: Math.round(slowdown), utilisation: Math.min(1.5, z.load * 0.6) };
  }).sort((a, b) => b.slowdownPct - a.slowdownPct).slice(0, 8);
  const forecast = [...d.predictions].sort((a, b) => a.horizonMin - b.horizonMin).slice(0, 12).map((h) => {
    const [from, to] = edgeName(h.zoneId);
    return { edge: h.zoneId, from, to, horizonMin: h.horizonMin, severity: h.severity, confidence: h.confidence };
  });
  const congestion = Math.max(0, ...d.predictions.filter((p) => p.horizonMin === 5).map((p) => p.severity)) * 100;

  history.push({ t: now, avail: (100 * availableNow) / Math.max(1, rs.length), bat: avgBat, wait: waiting, cong: congestion });
  while (history.length > 180) history.shift();
  const series = (a: (h: (typeof history)[number]) => number, b: (h: (typeof history)[number]) => number): IntelPoint[] =>
    history.filter((_, i) => i % Math.max(1, Math.floor(history.length / 60)) === 0).map((h) => ({ t: h.t, a: r1(a(h)), b: r1(b(h)) }));

  // ───── anomalies (the mock's insights carry no category → infer from the title) ─────
  const open = d.insights.filter((i) => ['NEW', 'ACKNOWLEDGED', 'ACTION_PROPOSED'].includes(i.state));
  const cat = (re: RegExp) => d.insights.filter((i) => re.test(i.title));
  const act = (re: RegExp) => open.filter((i) => re.test(i.title)).length;
  const maxQueueAge = Math.max(0, ...queue.map((q) => q.ageSec));
  const det = (id: string, title: string, description: string, rule: string, current: number, limit: number, unit: string, re: RegExp) => {
    const active = act(re);
    const state: DetectorState = active > 0 ? 'FIRING' : limit > 0 && current >= 0.7 * limit ? 'WATCH' : 'OK';
    return { id, title, description, rule, current, limit, unit, state, active, recent: cat(re).length };
  };
  const lowest = Math.min(100, ...rs.map((s) => s.robot.battery));
  const detectors = [
    det('idle', 'Unusually long idle time', 'A robot waits for work longer than the limit.', '> 10 min idle', 0, 600, 's', /idle/i),
    det('battery', 'Abnormal battery consumption', 'Energy use per metre is far above the fleet average (z-score), or a robot works below the critical level.', 'z ≥ 3.0', 0, 3, 'z', /battery|energy/i),
    det('orders', 'Blocked or unprocessed orders', 'Orders wait too long for a robot (limit depends on priority) or a robot stops on its route.', '> 180 s (STAT ×0.34, URGENT ×0.67); no progress > 45 s', maxQueueAge, 180, 's', /without a robot|waiting .*s|not making progress|blocked/i),
    det('bottleneck', 'Traffic bottlenecks', 'Several robots queue for the same node, or a corridor is forecast to be overloaded.', '≥ 2 robots waiting > 15 s', Math.max(0, ...[...bn.values()].map((v) => v.length)), 2, 'robots', /congestion|queuing|bottleneck|corridor/i),
    det('deadlock', 'Deadlocks', 'Robots block each other in a cycle; the core re-routes the lowest-priority one.', 'wait > 5 s in a cycle', 0, 1, '', /deadlock/i),
    det('offline', 'Robot offline', 'No VDA 5050 state message within 15 s.', 'no state > 15 s', 0, 1, 'robots', /offline/i),
  ];
  void lowest;

  return {
    ts: now,
    dispatch: {
      mode: d.system.mode, algorithm: 'Hungarian (global optimum)', assignments: d.tasks.filter((t) => t.assignedAt).length,
      lastDecision: d.tasks.filter((t) => t.assignedAt && t.robotId).sort((a, b) => (b.assignedAt ?? 0) - (a.assignedAt ?? 0)).slice(0, 4).map((t) => `${t.id} -> ${t.robotId}`),
      weights: { loadBalance: 25, battery: 0.6, congestion: 20, agingPerMin: AGING_PER_MIN, agingCap: AGING_CAP, recentWindowS: 600 },
      queue, queueLength: queued.length, load: loads, balanceIndex: Math.round(balance), loadSpread: counts.length ? Math.max(...counts) - Math.min(...counts) : 0,
      utilisationPct: Math.round((100 * busyN) / Math.max(1, rs.length)),
    },
    energy: {
      policy: POLICY, learnedPctPerMeter: 0.04, consumptionSamples: d.completions.length, consumptionMean: 0.04, consumptionStd: 0.004, chargeStops: 0,
      robots: energyRobots, chargers: chargerRows,
      availableNow, fleetSize: rs.length, availabilityPct: Math.round((100 * availableNow) / Math.max(1, rs.length)),
      charging: atCharger.length, lowBattery: energyRobots.filter((r) => r.level === 'LOW' || r.level === 'CRITICAL').length, avgBattery: avgBat,
      history: series((h) => h.avail, (h) => h.bat),
    },
    traffic: {
      policy: { lookaheadSegments: 2, deadlockMinWaitS: 5, autoResolve: true, predictionThreshold: 1 },
      robots: coordination, activeMissions: coordination.filter((c) => c.mission).length, waitingRobots: waiting,
      deadlocks: [], deadlocksResolved: 0, waitGraph: [],
      bottlenecks: [...bn.entries()].map(([name, waitingRobots]) => ({ node: name, name, waiting: waitingRobots, capacity: 1 })),
      zones: [], blockedEdges: d.blocked.map((id) => { const [from, to] = edgeName(id); return { id, from, to }; }),
      slowCorridors: slow, networkSlowdownPct: slow.length ? Math.round(slow.reduce((a, c) => a + c.slowdownPct, 0) / MAP_EDGES.length) : 0, forecast,
      history: series((h) => h.wait, (h) => h.cong),
    },
    forecast: mockForecast(d, now),
    anomalies: {
      detectors, autoResolve: true, activeCount: open.length,
      recent: [...d.insights].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map((i) => ({
        id: i.id, category: '', severity: i.severity, title: i.title, state: i.state, ageSec: Math.round(((now - i.createdAt) * scale) / 1000), message: i.staffMessage,
      })),
    },
  };
}
