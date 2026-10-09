// Shared contract types. In a real project these are generated from OpenAPI / AsyncAPI.

import { RUNTIME } from '../runtime-config';

/** The mock backend runs hospital time faster than wall-clock so KPIs move during a demo. The real core runs in real time. */
export const SIM_TIME_SCALE = RUNTIME.useMock ? 6 : 1;

// ───────────── Auth / RBAC ─────────────
export type Permission =
  | 'task:create' | 'task:read:own' | 'task:read:dept' | 'task:read:all' | 'task:cancel:own' | 'task:modify:any'
  | 'fleet:view' | 'fleet:view:full'
  | 'insight:view' | 'insight:act'
  | 'override:robot' | 'override:fleet' | 'override:estop'
  | 'simulation:run'
  | 'kpi:view:basic' | 'kpi:view:full'
  | 'config:manage' | 'audit:view';

export type Role = 'STAFF' | 'DEPT_LEAD' | 'OPERATOR' | 'MANAGER' | 'ADMIN';

export interface UserProfile {
  id: string;
  name: string;
  role: Role;
  roleLabel: string;
  /** Station id of the department the user belongs to (staff scoping). */
  department: string | null;
  permissions: Permission[];
}

// ───────────── Geometry / map ─────────────
export interface Vec { x: number; y: number; }
export type StationKind = 'PHARMACY' | 'LAB' | 'CSSD' | 'WARD' | 'OR' | 'CHARGING' | 'STORAGE' | 'KITCHEN' | 'LAUNDRY' | 'WASTE' | 'CHECKIN';
export interface Station { id: string; name: string; kind: StationKind; pos: Vec; queue: number; }

// ───────────── Live entities ─────────────
export type RobotStatus =
  | 'IDLE' | 'EN_ROUTE_TO_PICKUP' | 'CARRYING' | 'WAITING' | 'CHARGING'
  | 'FAULT' | 'MANUAL_OVERRIDE' | 'PAUSED';
export type RobotViewStatus = RobotStatus | 'STALE';

export interface Robot {
  id: string;
  name: string;
  pos: Vec;
  heading: number;      // radians
  speed: number;        // world units / s
  battery: number;      // 0..100
  status: RobotStatus;
  taskId: string | null;
  /** Remaining waypoints (node ids) of the current leg, next waypoint first. */
  route: string[];
  /** Planned waypoints after the current leg (e.g. the delivery leg while heading to pickup). */
  plan: string[];
  /** Server timestamp (ms) of this telemetry sample. */
  ts: number;
}

export type TaskSource = 'PHARMACY' | 'KITCHEN' | 'LAUNDRY' | 'STORAGE' | 'WARD';
export type TaskPriority = 'STAT' | 'URGENT' | 'ROUTINE';
export type TaskStatus = 'QUEUED' | 'ASSIGNED' | 'TO_PICKUP' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED';

export interface Task {
  id: string;
  source: TaskSource;
  from: string;          // station id
  to: string;            // station id
  priority: TaskPriority;
  status: TaskStatus;
  robotId: string | null;
  requester: string;     // user id
  requesterName: string;
  item: string;
  notes?: string;
  origin: 'REAL' | 'SIMULATED';
  createdAt: number;
  assignedAt?: number;
  pickedAt?: number;
  deliveredAt?: number;
  /** Remaining ETA in simulated seconds. */
  etaSec: number | null;
  version: number;
}

export interface ZoneOccupancy { id: string; a: string; b: string; load: number; blocked: boolean; }
export type HorizonMin = 5 | 15 | 30;
export interface HotspotPrediction {
  id: string; zoneId: string; center: Vec; radius: number;
  horizonMin: HorizonMin; severity: number; confidence: number;
}
export interface ZonesPayload { zones: ZoneOccupancy[]; stations: Pick<Station, 'id' | 'queue'>[]; }
export interface PredictionsPayload { generatedAt: number; items: HotspotPrediction[]; }

// ───────────── AI insights ─────────────
export type InsightSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
export type InsightState = 'NEW' | 'ACKNOWLEDGED' | 'ACTION_PROPOSED' | 'ACTION_APPLIED' | 'DISMISSED' | 'EXPIRED' | 'RESOLVED';
export interface SuggestedAction {
  id: string;
  label: string;
  impactMin: number;
  command: CommandRequest;
}
export interface Insight {
  id: string;
  severity: InsightSeverity;
  title: string;
  zoneId: string | null;
  stationId: string | null;
  etaMin: number;
  confidence: number;
  affectedTasks: number;
  state: InsightState;
  createdAt: number;
  validUntil: number;
  suggestion: SuggestedAction | null;
  /** Plain-language text for non-operator audiences. */
  staffMessage: string;
}

// ───────────── Commands ─────────────
export type CommandType =
  | 'PAUSE' | 'RESUME' | 'ESTOP' | 'RESET' | 'CHARGE' | 'GOTO' | 'TAKE_MANUAL' | 'RELEASE_MANUAL'
  | 'REASSIGN' | 'CANCEL_TASK' | 'SET_PRIORITY'
  | 'FLEET_HOLD' | 'FLEET_RESUME' | 'SET_MODE' | 'BLOCK_ZONE' | 'UNBLOCK_ZONE';

export interface CommandRequest {
  type: CommandType;
  targetId?: string;
  params?: Record<string, string | number | boolean>;
  reason?: string;
  expectedVersion?: number;
}
export type AckState = 'ACCEPTED' | 'EXECUTING' | 'DONE' | 'REJECTED';
export interface CommandAck { correlationId: string; state: AckState; reason?: string; }

// ───────────── Tasks API ─────────────
export interface TaskRequest {
  source: TaskSource;
  from: string;
  to: string;
  priority: TaskPriority;
  item: string;
  notes?: string;
  origin: 'REAL' | 'SIMULATED';
}
export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[]; }

// ───────────── KPI ─────────────
export interface KpiPoint {
  t: number;
  avgSec: number; p90Sec: number; tph: number; saved: number;
  wait: number; toPickup: number; transit: number; handover: number;
}
export interface KpiLive {
  avgTaskSec: number; p90TaskSec: number; tasksPerHour: number; staffMinSaved: number; slaMet: number;
  prev: { avgTaskSec: number | null; tasksPerHour: number | null };
  byStation: { stationId: string; count: number; avgSec: number }[];
  computedAt: number;
  methodologyVersion: string;
  point: KpiPoint;
}
export type KpiWindow = 'SHORT' | 'HOUR' | 'SESSION';

// ───────────── Realtime envelope ─────────────
export type TopicName =
  | 'fleet.robots' | 'fleet.zones' | 'ai.predictions' | 'ai.insights'
  | 'tasks.events' | 'commands.acks' | 'kpi.live' | 'system.status';
export interface Envelope<T = unknown> { topic: TopicName; seq: number; ts: number; payload: T; }

export interface SystemStatus {
  mode: 'AUTO' | 'SEMI_AUTO';
  hold: boolean;
  aiAvailable: boolean;
  blockedZones: string[];
  notice?: string;
}

export interface Snapshot {
  seq: number;
  ts: number;
  robots: Robot[];
  zones: ZoneOccupancy[];
  stations: Station[];
  predictions: HotspotPrediction[];
  tasks: Task[];
  insights: Insight[];
  kpi: KpiLive;
  system: SystemStatus;
}

export interface SubscriptionScope { userId: string; role: Role; }

export const KPI_TARGETS = { avgTaskSec: 300, tasksPerHour: 45, slaMet: 0.95 } as const;
export const SLA_SIM_MIN: Record<TaskPriority, number> = { STAT: 10, URGENT: 20, ROUTINE: 45 };
