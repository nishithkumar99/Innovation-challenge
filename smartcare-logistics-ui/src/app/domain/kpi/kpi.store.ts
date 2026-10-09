import { Injectable, computed, inject, signal } from '@angular/core';
import { auditTime } from 'rxjs';
import { FleetRestApi } from '../../core/backend/fleet-backend';
import { KPI_TARGETS, KpiLive, KpiPoint, KpiWindow } from '../../core/models';
import { ClockService, RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { fmtDuration, fmtMinutes } from '../../shared/util';
import { FleetStore } from '../fleet/fleet.store';

export type TileStatus = 'ok' | 'warn' | 'breach' | 'neutral';
export interface KpiTileVm {
  id: string;
  label: string;
  value: string;
  sub?: string;
  delta: { text: string; dir: 'up' | 'down' | 'flat'; good: boolean | null } | null;
  spark: number[];
  target?: string;
  status: TileStatus;
  estimate?: boolean;
  stale: boolean;
  info: string;
}

export const WINDOW_LABEL: Record<KpiWindow, string> = { SHORT: 'Last 30 min', HOUR: 'Last 1 h', SESSION: 'Session' };
const WINDOW_MS: Record<KpiWindow, number> = { SHORT: 300_000, HOUR: 600_000, SESSION: Infinity };

/** Snapshot (REST) + live delta (stream). The UI presents server values; it never computes KPI logic. */
@Injectable({ providedIn: 'root' })
export class KpiStore {
  private readonly gw = inject(RealtimeGateway);
  private readonly api = inject(FleetRestApi);
  private readonly clock = inject(ClockService);
  private readonly fleet = inject(FleetStore);

  readonly live = signal<KpiLive | null>(null);
  readonly allPoints = signal<KpiPoint[]>([]);
  readonly window = signal<KpiWindow>('HOUR');
  readonly loading = signal(false);

  readonly points = computed(() => {
    const cutoff = this.clock.now() - WINDOW_MS[this.window()];
    const pts = this.allPoints().filter((p) => p.t >= cutoff);
    const stride = Math.max(1, Math.ceil(pts.length / 100));
    return pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
  });

  readonly tiles = computed<KpiTileVm[]>(() => {
    const l = this.live();
    if (!l) return [];
    this.fleet.tick(); // re-evaluate staleness each second
    const pts = this.points();
    const stale = this.clock.now() - l.computedAt > 6000;
    const dAvg = l.prev.avgTaskSec == null ? null : l.avgTaskSec - l.prev.avgTaskSec;
    const dTph = l.prev.tasksPerHour == null ? null : l.tasksPerHour - l.prev.tasksPerHour;
    const dir = (d: number) => (d > 0 ? 'up' : d < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat';
    const sign = (d: number) => (d > 0 ? '+' : d < 0 ? '−' : '±');
    return [
      {
        id: 'avg', label: 'Avg time / task', value: fmtDuration(l.avgTaskSec), sub: `P90 ${fmtDuration(l.p90TaskSec)}`,
        delta: dAvg == null ? null : { text: `${sign(dAvg)}${fmtDuration(Math.abs(dAvg))}`, dir: dir(dAvg), good: dAvg <= 0 },
        spark: pts.map((p) => p.avgSec), target: `target ${fmtDuration(KPI_TARGETS.avgTaskSec)}`,
        status: l.avgTaskSec === 0 ? 'neutral' : l.avgTaskSec <= KPI_TARGETS.avgTaskSec ? 'ok' : l.avgTaskSec <= KPI_TARGETS.avgTaskSec * 1.2 ? 'warn' : 'breach',
        stale, info: 'Mean creation→delivery time over the last simulated hour, server-aggregated.',
      },
      {
        id: 'tph', label: 'Tasks completed / hour', value: String(l.tasksPerHour),
        delta: dTph == null ? null : { text: `${sign(dTph)}${Math.abs(dTph)}`, dir: dir(dTph), good: dTph >= 0 },
        spark: pts.map((p) => p.tph), target: `target ${KPI_TARGETS.tasksPerHour}`,
        status: l.tasksPerHour >= KPI_TARGETS.tasksPerHour ? 'ok' : l.tasksPerHour >= KPI_TARGETS.tasksPerHour * 0.8 ? 'warn' : 'breach',
        stale, info: 'Rolling deliveries in the last simulated hour vs. the previous hour.',
      },
      {
        id: 'saved', label: 'Staff minutes saved', value: fmtMinutes(l.staffMinSaved), sub: 'today (est.)', delta: null,
        spark: pts.map((p) => p.saved), status: 'neutral', estimate: true, stale,
        info: `Server estimate (walk time + handover avoided). Methodology: ${l.methodologyVersion}.`,
      },
      {
        id: 'sla', label: 'Deliveries within SLA', value: `${(l.slaMet * 100).toFixed(1)} %`, delta: null, spark: [],
        target: `target ${(KPI_TARGETS.slaMet * 100).toFixed(0)} %`,
        status: l.slaMet >= KPI_TARGETS.slaMet ? 'ok' : l.slaMet >= 0.85 ? 'warn' : 'breach',
        stale, info: 'Share of deliveries completed inside their priority SLA (STAT 10, URGENT 20, ROUTINE 45 min).',
      },
    ];
  });

  constructor() {
    this.gw.snapshot$.subscribe((s) => {
      this.live.set(s.kpi);
      this.loading.set(true);
      this.api.getKpiSeries('SESSION').subscribe({
        next: (pts) => { this.allPoints.set(pts); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
    });
    this.gw.topic$<KpiLive>('kpi.live').pipe(auditTime(1000)).subscribe((l) => {
      this.live.set(l);
      this.allPoints.update((p) => [...p, l.point].slice(-1500));
    });
  }

  setWindow(w: KpiWindow): void { this.window.set(w); }
}
