import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ClockService } from '../../core/realtime/realtime-gateway';
import { slaState } from '../../shared/util';
import { InsightsStore } from '../insights/insights.store';
import { TaskStore } from '../tasks/task.store';
import { FleetStore } from './fleet.store';
import { UiStore } from './ui.store';

/** “At a glance” strip: how many robots are doing what, and whether anything needs attention. Chips are shortcuts. */
@Component({
  selector: 'scl-fleet-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="strip" role="status" aria-label="Fleet summary">
      @for (c of chips(); track c.key) {
        <button type="button" class="pill" [class]="c.tone" [attr.title]="c.title" (click)="c.go()">
          <b>{{ c.value }}</b> {{ c.label }}
        </button>
      }
      @if (attention() === 0 && late() === 0 && insights.criticalCount() === 0) { <span class="allgood">✔ All clear</span> }
    </div>
  `,
  styles: [`
    .strip { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .pill { font: inherit; font-size: .78rem; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-dim); border-radius: 999px; padding: .15rem .65rem; cursor: pointer; }
    .pill b { color: var(--text); font-size: .9rem; margin-right: .15rem; }
    .pill:hover { border-color: var(--accent); }
    .pill.warn { border-color: var(--warn); } .pill.crit { border-color: var(--crit); background: color-mix(in srgb, var(--crit) 14%, var(--surface-2)); }
    .allgood { color: var(--ok); font-weight: 700; font-size: .8rem; margin-left: .3rem; }
  `],
})
export class FleetSummaryComponent {
  protected readonly fleet = inject(FleetStore);
  protected readonly insights = inject(InsightsStore);
  private readonly tasks = inject(TaskStore);
  private readonly ui = inject(UiStore);
  private readonly clock = inject(ClockService);

  private readonly groups = computed(() => {
    const g = { active: 0, idle: 0, charging: 0, attention: [] as string[] };
    for (const r of this.fleet.robotViews()) {
      switch (r.viewStatus) {
        case 'EN_ROUTE_TO_PICKUP': case 'CARRYING': case 'WAITING': g.active++; break;
        case 'IDLE': g.idle++; break;
        case 'CHARGING': g.charging++; break;
        default: g.attention.push(r.id);
      }
    }
    return g;
  });
  protected readonly attention = computed(() => this.groups().attention.length);
  protected readonly late = computed(() => {
    this.fleet.tick();
    return this.tasks.open().filter((t) => slaState(t, this.clock.now()) === 'breach').length;
  });

  protected readonly chips = computed(() => {
    const g = this.groups();
    const out: { key: string; value: number; label: string; tone: string; title: string; go: () => void }[] = [
      { key: 'active', value: g.active, label: 'working', tone: '', title: 'Robots on a task', go: () => this.ui.dockTab.set('fleet') },
      { key: 'idle', value: g.idle, label: 'idle', tone: '', title: 'Robots waiting for work', go: () => this.ui.dockTab.set('fleet') },
      { key: 'chg', value: g.charging, label: 'charging', tone: '', title: 'Robots at the charging dock', go: () => this.ui.dockTab.set('fleet') },
      { key: 'open', value: this.tasks.open().length, label: 'open tasks', tone: '', title: 'Show the task queue', go: () => this.ui.dockTab.set('tasks') },
    ];
    if (g.attention.length) out.push({ key: 'att', value: g.attention.length, label: 'need attention', tone: 'crit', title: 'Paused, manual, faulted or no signal. Click to select.', go: () => this.ui.select({ kind: 'robot', id: g.attention[0] }) });
    if (this.late()) out.push({ key: 'late', value: this.late(), label: 'running late', tone: 'warn', title: 'Tasks past their target time', go: () => this.ui.dockTab.set('tasks') });
    if (this.insights.criticalCount()) out.push({ key: 'crit', value: this.insights.criticalCount(), label: 'critical alerts', tone: 'crit', title: 'See alerts on the right', go: () => this.ui.select(null) });
    return out;
  });
}
