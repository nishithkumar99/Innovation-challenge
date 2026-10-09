import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { HasPermissionDirective } from '../../core/auth/permission.directive';
import { deliverCsv, toCsv } from '../../core/layout/csv';
import { NotificationService } from '../../core/layout/notification.service';
import { stationName } from '../../core/map-data';
import { KPI_TARGETS, KpiWindow } from '../../core/models';
import { ChartComponent, ChartSeries } from '../../shared/ui/chart.component';
import { fmtDuration, fmtMinutes } from '../../shared/util';
import { KpiMiniStripComponent } from './kpi-mini-strip.component';
import { KpiStore, WINDOW_LABEL } from './kpi.store';

const WINDOWS: KpiWindow[] = ['SHORT', 'HOUR', 'SESSION'];

/** /kpi — filters live in the URL (shareable); charts need `kpi:view:full`, tiles need `kpi:view:basic`. */
@Component({
  selector: 'scl-kpi-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiMiniStripComponent, ChartComponent, HasPermissionDirective],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>KPIs</h1><p>Server-aggregated metrics. Estimates are labelled “est.”.</p></div>
        <div class="tools">
          <div class="seg" role="radiogroup" aria-label="Time window">
            @for (w of windows; track w) {
              <button type="button" class="btn sm" role="radio" [class.primary]="store.window() === w" [attr.aria-checked]="store.window() === w" (click)="setWindow(w)">{{ label(w) }}</button>
            }
          </div>
          <button *sclHasPermission="'kpi:view:full'" type="button" class="btn sm" (click)="exportCsv()">⭳ Export CSV</button>
        </div>
      </div>

      <scl-kpi-mini-strip />

      <ng-container *sclHasPermission="'kpi:view:full'; else basic">
        <div class="charts">
          <scl-chart title="Time per task (mm:ss)" type="line" [series]="timeSeries()" [xs]="xs()" [band]="band()" [fmt]="mmss"
                     [target]="{ value: targets.avgTaskSec, label: 'target' }" />
          <scl-chart title="Time breakdown by phase" type="stack" [series]="phaseSeries()" [xs]="phaseXs()" [fmt]="mmss" />
          <scl-chart title="Tasks completed per hour" type="bar" [series]="tphSeries()" [xs]="xs()" [fmt]="int"
                     [target]="{ value: targets.tasksPerHour, label: 'target ' + targets.tasksPerHour }" />
          <scl-chart title="Staff minutes saved (cumulative, est.)" type="area" [series]="savedSeries()" [xs]="xs()" [fmt]="mins" />
        </div>

        <section class="card dept">
          <h3 class="panel-title">By destination</h3>
          <table class="grid" aria-label="Deliveries by destination">
            <thead><tr><th>Destination</th><th>Deliveries</th><th></th><th>Avg time</th></tr></thead>
            <tbody>
              @for (r of rows(); track r.id) {
                <tr>
                  <td>{{ r.name }}</td><td>{{ r.count }}</td>
                  <td class="barcell"><div class="progress"><i [style.width.%]="r.pct"></i></div></td>
                  <td>{{ r.avg }}</td>
                </tr>
              } @empty { <tr><td colspan="4" class="empty">No deliveries in this window yet.</td></tr> }
            </tbody>
          </table>
        </section>
        <p class="faint note">Methodology: {{ store.live()?.methodologyVersion }}. Metrics are presented as computed by the backend; the UI does not derive KPI values.</p>
      </ng-container>
      <ng-template #basic><div class="banner info">Detailed charts and CSV export are available to fleet managers.</div></ng-template>
    </div>
  `,
  styles: [`
    .tools { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; } .seg { display: flex; gap: .25rem; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(26rem, 1fr)); gap: .8rem; }
    .dept { padding: .8rem 1rem; } .barcell { width: 40%; } .note { font-size: .75rem; margin: 0; }
    @media (max-width: 600px) { .charts { grid-template-columns: 1fr; } }
  `],
})
export class KpiDashboardPageComponent {
  readonly window = input<string>();
  protected readonly store = inject(KpiStore);
  private readonly router = inject(Router);
  private readonly toast = inject(NotificationService);

  protected readonly windows = WINDOWS;
  protected readonly targets = KPI_TARGETS;
  protected readonly mmss = (n: number) => fmtDuration(n);
  protected readonly int = (n: number) => String(Math.round(n));
  protected readonly mins = (n: number) => fmtMinutes(n);
  protected label(w: KpiWindow) { return WINDOW_LABEL[w]; }

  protected readonly xs = computed(() => this.store.points().map((p) => new Date(p.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
  protected readonly timeSeries = computed<ChartSeries[]>(() => [
    { name: 'Average', values: this.store.points().map((p) => p.avgSec), color: 'var(--c1)' },
    { name: 'P90', values: this.store.points().map((p) => p.p90Sec), color: 'var(--c2)' },
  ]);
  protected readonly band = computed(() => ({
    lo: this.store.points().map((p) => p.avgSec), hi: this.store.points().map((p) => p.p90Sec), color: 'var(--c2)', label: 'Average → P90',
  }));
  protected readonly phasePoints = computed(() => this.store.points().slice(-24));
  protected readonly phaseXs = computed(() => this.phasePoints().map((p) => new Date(p.t).toLocaleTimeString('de-DE', { minute: '2-digit', second: '2-digit' })));
  protected readonly phaseSeries = computed<ChartSeries[]>(() => {
    const p = this.phasePoints();
    return [
      { name: 'Wait to assign', values: p.map((x) => x.wait), color: 'var(--c5)' },
      { name: 'To pickup', values: p.map((x) => x.toPickup), color: 'var(--c2)' },
      { name: 'In transit', values: p.map((x) => x.transit), color: 'var(--c1)' },
      { name: 'Handover', values: p.map((x) => x.handover), color: 'var(--c3)' },
    ];
  });
  protected readonly tphSeries = computed<ChartSeries[]>(() => [{ name: 'Tasks / hour', values: this.store.points().map((p) => p.tph), color: 'var(--c1)' }]);
  protected readonly savedSeries = computed<ChartSeries[]>(() => [{ name: 'Minutes saved (est.)', values: this.store.points().map((p) => p.saved), color: 'var(--c3)' }]);
  protected readonly rows = computed(() => {
    const by = this.store.live()?.byStation ?? [];
    const max = Math.max(1, ...by.map((b) => b.count));
    return by.map((b) => ({ id: b.stationId, name: stationName(b.stationId), count: b.count, pct: (b.count / max) * 100, avg: fmtDuration(b.avgSec) }));
  });

  constructor() {
    // URL → store (query param is the source of truth for the filter)
    effect(() => {
      const w = this.window();
      if (w && (WINDOWS as string[]).includes(w)) this.store.setWindow(w as KpiWindow);
    });
  }

  protected setWindow(w: KpiWindow): void {
    void this.router.navigate([], { queryParams: { window: w }, queryParamsHandling: 'merge' });
  }

  protected async exportCsv(): Promise<void> {
    const csv = toCsv(
      ['time', 'avg_sec', 'p90_sec', 'tasks_per_hour', 'staff_min_saved_est', 'wait_sec', 'to_pickup_sec', 'transit_sec', 'handover_sec'],
      this.store.points().map((p) => [new Date(p.t).toISOString(), p.avgSec, p.p90Sec, p.tph, p.saved, p.wait, p.toPickup, p.transit, p.handover]),
    );
    const r = await deliverCsv(`kpi-${this.store.window().toLowerCase()}.csv`, csv);
    this.toast.push(r === 'failed' ? 'error' : 'success', r === 'failed' ? 'Export failed.' : 'KPI data exported (also copied to your clipboard when allowed).');
  }
}
