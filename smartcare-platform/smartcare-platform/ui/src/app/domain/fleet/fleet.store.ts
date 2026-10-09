import { Injectable, computed, inject, signal } from '@angular/core';
import { bufferTime, filter, map } from 'rxjs';
import { ClockService, RealtimeGateway } from '../../core/realtime/realtime-gateway';
import {
  HorizonMin, HotspotPrediction, PredictionsPayload, Robot, RobotViewStatus, Station, SystemStatus, ZoneOccupancy, ZonesPayload,
} from '../../core/models';

export const STALE_AFTER_MS = 3000;
export interface RobotView extends Robot { stale: boolean; viewStatus: RobotViewStatus; }

/** Server-pushed live state: normalized, entity-keyed, written in batches (blueprint 4.4 / 4.5.3). */
@Injectable({ providedIn: 'root' })
export class FleetStore {
  private readonly gw = inject(RealtimeGateway);
  private readonly clock = inject(ClockService);

  readonly robots = signal<Record<string, Robot>>({});
  readonly stations = signal<Record<string, Station>>({});
  readonly zones = signal<Record<string, ZoneOccupancy>>({});
  readonly predictions = signal<HotspotPrediction[]>([]);
  readonly system = signal<SystemStatus>({ mode: 'AUTO', hold: false, aiAvailable: true, blockedZones: [] });
  /** 1 Hz heartbeat used to derive staleness without per-message timers. */
  readonly tick = signal(Date.now());

  readonly robotViews = computed<RobotView[]>(() => {
    this.tick();
    const now = this.clock.now();
    return Object.values(this.robots())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => {
        const stale = now - r.ts > STALE_AFTER_MS;
        return { ...r, stale, viewStatus: stale ? 'STALE' : r.status };
      });
  });
  readonly robotViewById = computed(() => Object.fromEntries(this.robotViews().map((r) => [r.id, r])) as Record<string, RobotView>);
  readonly online = computed(() => this.robotViews().filter((r) => !r.stale && r.status !== 'FAULT').length);
  readonly faulted = computed(() => this.robotViews().filter((r) => r.status === 'FAULT' || r.stale));
  readonly stationList = computed(() => Object.values(this.stations()));

  constructor() {
    setInterval(() => this.tick.set(Date.now()), 1000);

    this.gw.snapshot$.subscribe((s) => {
      this.robots.set(Object.fromEntries(s.robots.map((r) => [r.id, r])));
      this.stations.set(Object.fromEntries(s.stations.map((x) => [x.id, x])));
      this.zones.set(Object.fromEntries(s.zones.map((z) => [z.id, z])));
      this.predictions.set(s.predictions);
      this.system.set(s.system);
    });

    // Telemetry: batch → coalesce (latest per robot) → ONE store write per batch.
    this.gw.topic$<Robot[]>('fleet.robots').pipe(
      bufferTime(100),
      map((batches) => {
        const latest = new Map<string, Robot>();
        for (const b of batches) for (const r of b) latest.set(r.id, r);
        return [...latest.values()];
      }),
      filter((x) => x.length > 0),
    ).subscribe((batch) => {
      this.robots.update((cur) => {
        const next = { ...cur };
        for (const r of batch) if (!cur[r.id] || r.ts >= cur[r.id].ts) next[r.id] = r; // out-of-order guard
        return next;
      });
    });

    this.gw.topic$<ZonesPayload>('fleet.zones').subscribe((p) => {
      if (p.zones.length) this.zones.set(Object.fromEntries(p.zones.map((z) => [z.id, z])));
      this.stations.update((cur) => {
        const next = { ...cur };
        for (const q of p.stations) if (next[q.id]) next[q.id] = { ...next[q.id], queue: q.queue };
        return next;
      });
    });
    this.gw.topic$<PredictionsPayload>('ai.predictions').subscribe((p) => this.predictions.set(p.items));
    this.gw.topic$<SystemStatus>('system.status').subscribe((s) => this.system.set(s));
  }

  predictionsFor(h: HorizonMin): HotspotPrediction[] {
    return this.predictions().filter((p) => p.horizonMin === h);
  }
}
