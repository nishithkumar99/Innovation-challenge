// Shape of GET /api/intel (Java: IntelService). Explains the AI decisions along the four focus areas.

export interface IntelCandidate {
  robot: string; eligible: boolean; reason: string | null; etaToPickupSec: number | null;
  battery: number; recentTasks: number; cost: number | null;
}
export interface IntelQueueItem {
  id: string; priority: 'STAT' | 'URGENT' | 'ROUTINE'; item: string; from: string; to: string; fromName: string; toName: string;
  ageSec: number; basePoints: number; agingPoints: number; points: number; candidates: IntelCandidate[];
}
export interface IntelLoad { robot: string; recentTasks: number; status: string; busy: boolean; battery: number; }
export interface IntelDispatch {
  mode: string; algorithm: string; assignments: number; lastDecision: string[];
  weights: Record<string, number>;
  queue: IntelQueueItem[]; queueLength: number;
  load: IntelLoad[]; balanceIndex: number; loadSpread: number; utilisationPct: number;
}

export type BatteryLevel = 'CRITICAL' | 'LOW' | 'OK' | 'FULL';
export interface IntelEnergyRobot {
  robot: string; battery: number; level: BatteryLevel; charging: boolean; available: boolean; rangeM: number;
  action: string; online: boolean; consumptionZ: number; status: string;
}
export interface IntelCharger { id: string; name: string; capacity: number; occupied: number; robots: string[]; incoming: string[]; }
export interface IntelPoint { t: number; a: number; b: number; }
export interface IntelEnergy {
  policy: { critical: number; low: number; target: number; minRelease: number; opportunisticBelow: number; reserve: number };
  learnedPctPerMeter: number; consumptionSamples: number; consumptionMean: number; consumptionStd: number; chargeStops: number;
  robots: IntelEnergyRobot[]; chargers: IntelCharger[];
  availableNow: number; fleetSize: number; availabilityPct: number; charging: number; lowBattery: number; avgBattery: number;
  /** a = availability %, b = average battery % */
  history: IntelPoint[];
}

export interface IntelCoordination {
  robot: string; status: string; mission: string | null; taskId: string | null; at: string | null; heading: string | null;
  released: number; remaining: number; waitingFor: string | null; waitSec: number; waitNode: string | null;
}
export interface IntelZone { id: string; name: string; restricted: boolean; nodes: number; edges: number; nodeNames: string[]; }
export interface IntelCorridor { id: string; from: string; to: string; freeSec: number; learnedSec: number; slowdownPct: number; utilisation: number; }
export interface IntelForecast { edge: string; from: string | null; to: string | null; horizonMin: number; severity: number; confidence: number; }
export interface IntelTraffic {
  policy: { lookaheadSegments: number; deadlockMinWaitS: number; autoResolve: boolean; predictionThreshold: number };
  robots: IntelCoordination[]; activeMissions: number; waitingRobots: number;
  deadlocks: { robots: string[]; resolution: string; ageSec: number }[]; deadlocksResolved: number;
  waitGraph: { robot: string; blockedBy: string[] }[];
  bottlenecks: { node: string; name: string; waiting: string[]; capacity: number }[];
  zones: IntelZone[]; blockedEdges: { id: string; from: string | null; to: string | null }[];
  slowCorridors: IntelCorridor[]; networkSlowdownPct: number; forecast: IntelForecast[];
  /** a = robots waiting, b = congestion index % */
  history: IntelPoint[];
}

export type DetectorState = 'OK' | 'WATCH' | 'FIRING';
export interface IntelDetector {
  id: string; title: string; description: string; rule: string; current: number; limit: number; unit: string;
  state: DetectorState; active: number; recent: number;
}
export interface IntelAnomalies {
  detectors: IntelDetector[]; autoResolve: boolean; activeCount: number;
  recent: { id: string; category: string; severity: string; title: string; state: string; ageSec: number; message: string | null }[];
}

export interface IntelDemandForecast {
  enabled: boolean; ready: boolean; model: string; bucketSeconds: number; trainedBuckets: number; minBuckets: number;
  mae: number; naiveMae: number; improvementPct: number; expected10: number; expected30: number; busyThreshold: number;
  demandLevel: 'LEARNING' | 'LOW' | 'NORMAL' | 'HIGH'; prePosition: boolean;
  stations: { id: string; name: string; expected10: number; expected30: number; robots: string[] }[];
  /** a = actual orders per bucket, b = what the model predicted */
  history: IntelPoint[];
  decisions: { type: 'PRE_POSITION' | 'KEPT_READY' | 'RELEASED_EARLY'; text: string; ageSec: number }[];
  counters: Partial<Record<string, number>>;
}

export interface Intel {
  ts: number;
  dispatch: IntelDispatch;
  energy: IntelEnergy;
  traffic: IntelTraffic;
  anomalies: IntelAnomalies;
  forecast: IntelDemandForecast;
}
