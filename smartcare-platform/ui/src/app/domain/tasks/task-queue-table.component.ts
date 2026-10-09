import { ScrollingModule } from '@angular/cdk/scrolling';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { deliverCsv, toCsv } from '../../core/layout/csv';
import { NotificationService } from '../../core/layout/notification.service';
import { stationName } from '../../core/map-data';
import { SIM_TIME_SCALE, Task } from '../../core/models';
import { ClockService } from '../../core/realtime/realtime-gateway';
import { DurationPipe, TASK_STATUS_LABEL, fmtDuration, simAgeSec, slaState } from '../../shared/util';
import { FleetStore } from '../fleet/fleet.store';
import { UiStore } from '../fleet/ui.store';
import { TaskStore } from './task.store';

const SLA_VIEW = {
  ok: { icon: '✔', label: 'On time', cls: 'ok' }, warn: { icon: '▲', label: 'At risk', cls: 'warn' },
  breach: { icon: '✖', label: 'Late', cls: 'crit' }, done: { icon: '', label: '', cls: 'neutral' },
};

/** Virtual-scrolled task table: scales to thousands of rows; live patches merge by task id. */
@Component({
  selector: 'scl-task-queue-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScrollingModule, DurationPipe],
  template: `
    <div class="wrap">
      <div class="bar">
        <select aria-label="Filter by status" [value]="status()" (change)="status.set($any($event.target).value)">
          <option value="OPEN">Open tasks</option><option value="ALL">All tasks</option>
          <option value="DELIVERED">Delivered</option><option value="CANCELLED">Cancelled</option>
        </select>
        <input type="search" placeholder="Search id, station, robot…" aria-label="Search tasks" [value]="query()" (input)="query.set($any($event.target).value)" />
        <div class="chips" role="group" aria-label="Quick filters">
          @for (f of quick; track f.v) {
            <button type="button" class="chip-btn" [class.on]="quickFilter() === f.v" [attr.aria-pressed]="quickFilter() === f.v" (click)="quickFilter.set(f.v)">{{ f.label }}</button>
          }
        </div>
        <span class="faint count">{{ rows().length }} shown</span>
        <button type="button" class="btn sm" (click)="exportCsv()" title="Download the visible rows as CSV (also copied to the clipboard)">⭳ CSV</button>
      </div>
      <div class="hdr row-grid" role="row">
        <span>Task</span><span>Route</span><span>Priority</span><span>Status</span><span>Robot</span><span>ETA</span><span>Age</span><span>SLA</span>
      </div>
      <cdk-virtual-scroll-viewport itemSize="38" class="vp" role="table" aria-label="Tasks">
        <div *cdkVirtualFor="let t of rows(); trackBy: trackId" class="row-grid body" role="row" tabindex="0"
             [class.selected]="ui.selection()?.id === t.id" (click)="ui.select({ kind: 'task', id: t.id })" (keydown.enter)="ui.select({ kind: 'task', id: t.id })">
          <span class="mono">{{ t.id }}@if (t.origin === 'SIMULATED') { <span class="chip warn sim" title="Simulated">SIM</span> }</span>
          <span class="route" [title]="t.item">{{ name(t.from) }} → {{ name(t.to) }}</span>
          <span><span class="chip" [class]="t.priority === 'STAT' ? 'crit' : t.priority === 'URGENT' ? 'warn' : 'neutral'">{{ t.priority }}</span></span>
          <span>{{ statusLabel(t.status) }}</span>
          <span>{{ t.robotId ?? '—' }}</span>
          <span>{{ t.etaSec | duration }}</span>
          <span>{{ age(t) }}</span>
          <span>@if (sla(t); as s) { @if (s.label) { <span class="chip" [class]="s.cls">{{ s.icon }} {{ s.label }}</span> } }</span>
        </div>
      </cdk-virtual-scroll-viewport>
      @if (!rows().length) { <div class="empty">No tasks match these filters. @if (quickFilter() !== 'ALL') { <button type="button" class="chip-btn" (click)="quickFilter.set('ALL')">Show all</button> } </div> }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; min-height: 0; }
    .wrap { height: 100%; display: flex; flex-direction: column; min-height: 0; }
    .bar { display: flex; gap: .5rem; align-items: center; padding: .4rem .5rem; }
    .bar select, .bar input { min-height: 1.9rem; padding: .2rem .5rem; font-size: .8rem; }
    .bar input { flex: 1; min-width: 0; }
    .count { font-size: .75rem; white-space: nowrap; }
    .chips { display: flex; gap: .25rem; }
    .chip-btn { font: inherit; font-size: .74rem; border: 1px solid var(--border); background: transparent; color: var(--text-dim); border-radius: 999px; padding: .1rem .55rem; cursor: pointer; }
    .chip-btn.on { background: color-mix(in srgb, var(--accent) 22%, transparent); border-color: var(--accent); color: var(--text); }
    .row-grid { display: grid; grid-template-columns: 6.2rem minmax(10rem, 2fr) 5.5rem 6.5rem 4rem 4.5rem 4.5rem 6.5rem; gap: .5rem; align-items: center; padding: 0 .6rem; }
    .hdr { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); font-weight: 700; padding-bottom: .3rem; border-bottom: 1px solid var(--border); }
    .vp { flex: 1; min-height: 0; }
    .body { height: 38px; font-size: .8rem; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); cursor: pointer; }
    .body:hover { background: var(--surface-2); } .body.selected { background: color-mix(in srgb, var(--accent) 16%, transparent); }
    .route { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sim { margin-left: .3rem; font-size: .6rem; padding: 0 .3rem; }
  `],
})
export class TaskQueueTableComponent {
  readonly limit = input<number | null>(null);
  protected readonly ui = inject(UiStore);
  private readonly store = inject(TaskStore);
  private readonly fleet = inject(FleetStore);
  private readonly clock = inject(ClockService);

  protected readonly status = signal<'OPEN' | 'ALL' | 'DELIVERED' | 'CANCELLED'>('OPEN');
  protected readonly query = signal('');
  protected readonly quickFilter = signal<'ALL' | 'STAT' | 'LATE' | 'UNASSIGNED'>('ALL');
  protected readonly quick = [
    { v: 'ALL', label: 'All' }, { v: 'STAT', label: 'STAT' }, { v: 'LATE', label: 'Late' }, { v: 'UNASSIGNED', label: 'Waiting for robot' },
  ] as const;
  private readonly toast = inject(NotificationService);
  protected readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    const base = this.status() === 'OPEN' ? this.store.open()
      : this.status() === 'ALL' ? this.store.all() : this.store.all().filter((t) => t.status === this.status());
    const filtered = q
      ? base.filter((t) => `${t.id} ${stationName(t.from)} ${stationName(t.to)} ${t.robotId ?? ''} ${t.item}`.toLowerCase().includes(q))
      : base;
    this.fleet.tick(); // re-evaluate “late” once per second
    const now = this.clock.now();
    const q2 = this.quickFilter();
    const quick = q2 === 'ALL' ? filtered : filtered.filter((t) =>
      q2 === 'STAT' ? t.priority === 'STAT' : q2 === 'LATE' ? slaState(t, now) === 'breach' : t.status === 'QUEUED');
    return this.limit() ? quick.slice(0, this.limit()!) : quick;
  });

  protected async exportCsv(): Promise<void> {
    const csv = toCsv(
      ['id', 'from', 'to', 'priority', 'status', 'robot', 'item', 'created', 'eta_sec', 'origin'],
      this.rows().map((t) => [t.id, stationName(t.from), stationName(t.to), t.priority, TASK_STATUS_LABEL[t.status], t.robotId, t.item, new Date(t.createdAt).toISOString(), t.etaSec, t.origin]),
    );
    const r = await deliverCsv('tasks.csv', csv);
    this.toast.push(r === 'failed' ? 'error' : 'success', r === 'failed' ? 'Export failed.' : `${this.rows().length} tasks exported (also copied to your clipboard when allowed).`);
  }
  protected trackId = (_: number, t: Task) => t.id;
  protected name(id: string) { return stationName(id); }
  protected statusLabel(s: Task['status']) { return TASK_STATUS_LABEL[s]; }
  protected age(t: Task): string {
    this.fleet.tick();
    if (t.deliveredAt) return fmtDuration(((t.deliveredAt - t.createdAt) / 1000) * SIM_TIME_SCALE);
    return fmtDuration(simAgeSec(t.createdAt, this.clock.now()));
  }
  protected sla(t: Task) {
    this.fleet.tick();
    return SLA_VIEW[slaState(t, this.clock.now())];
  }
}
