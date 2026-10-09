import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { HasPermissionDirective } from '../../core/auth/permission.directive';
import { stationName } from '../../core/map-data';
import { Task, TaskSource } from '../../core/models';
import { ProgressStepsComponent } from '../../shared/ui/progress-steps.component';
import { TASK_STATUS_LABEL } from '../../shared/util';
import { FleetStore } from '../fleet/fleet.store';
import { MapCanvasComponent } from '../fleet/map-canvas.component';
import { InsightsStore } from '../insights/insights.store';
import { KpiMiniStripComponent } from '../kpi/kpi-mini-strip.component';
import { OverrideFacade } from '../overrides/override.facade';
import { TaskFormComponent } from '../tasks/task-form.component';
import { SOURCES } from '../tasks/task-templates';
import { TaskStore } from '../tasks/task.store';

const STEPS: { label: string; match: Task['status'][] }[] = [
  { label: 'Requested', match: ['QUEUED'] },
  { label: 'Robot assigned', match: ['ASSIGNED', 'TO_PICKUP'] },
  { label: 'On the way', match: ['IN_TRANSIT'] },
  { label: 'Delivered', match: ['DELIVERED'] },
];

/** Plain-language "about N min" for non-operators. */
function humanEta(sec: number | null): string {
  if (sec == null) return 'calculating…';
  const min = Math.max(1, Math.round(sec / 60));
  return `about ${min} min`;
}

/** Plain-language delay banner shared by the staff pages (aggregate only, no actions). */
@Component({
  selector: 'scl-delay-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (n of notices(); track n.id) {
      <div class="banner warn" role="status">▲ {{ n.staffMessage }}</div>
    }
  `,
  styles: [`:host { display: flex; flex-direction: column; gap: .4rem; }`],
})
export class DelayBannerComponent {
  private readonly insights = inject(InsightsStore);
  protected readonly notices = computed(() => this.insights.staffNotices().slice(0, 2));
}

/** /request/new — pick a source, tweak, send. */
@Component({
  selector: 'scl-new-request-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TaskFormComponent, DelayBannerComponent],
  template: `
    <div class="page touch">
      <div class="page-head"><div><h1>New transport request</h1><p>Choose what you need moved. A robot is assigned automatically.</p></div></div>
      <scl-delay-banner />
      <div class="pads" role="radiogroup" aria-label="What do you need?">
        @for (s of sources; track s.source) {
          <button type="button" role="radio" class="pad card" [class.on]="selected() === s.source" [attr.aria-checked]="selected() === s.source" (click)="selected.set(s.source)">
            <span class="ic">{{ s.icon }}</span><strong>{{ s.label }}</strong><small>{{ s.blurb }}</small>
          </button>
        }
      </div>
      <div class="card formcard"><scl-task-form [source]="selected()" [compact]="true" [defaultFrom]="startFrom()" [defaultTo]="startTo()" [defaultPriority]="priority() ?? null" /></div>
    </div>
  `,
  styles: [`
    .pads { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .7rem; }
    .pad { display: flex; flex-direction: column; align-items: flex-start; gap: .15rem; padding: .9rem 1rem; cursor: pointer; text-align: left; color: var(--text); font: inherit; min-height: 6rem; }
    .pad .ic { font-size: 1.6rem; } .pad small { color: var(--text-dim); }
    .pad.on { border-color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); }
    .formcard { padding: 1.1rem 1.2rem; max-width: 46rem; }
  `],
})
export class NewRequestPageComponent {
  private readonly auth = inject(AuthService);
  protected readonly sources = SOURCES;
  protected readonly selected = signal<TaskSource>('PHARMACY');
  protected readonly dept = computed(() => this.auth.user().department);

  /** Pre-fill from a link (“Request again”): /request/new?source=LAB&from=WA&to=LAB&priority=URGENT */
  readonly source = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly priority = input<string>();
  protected readonly startFrom = computed(() => this.from() ?? this.dept());
  protected readonly startTo = computed(() => this.to() ?? this.dept());

  constructor() {
    effect(() => {
      const s = this.source();
      if (s && SOURCES.some((x) => x.source === s)) this.selected.set(s as TaskSource);
    });
  }
}

/** /request/mine — my requests with live status. */
@Component({
  selector: 'scl-my-requests-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DelayBannerComponent, ProgressStepsComponent],
  template: `
    <div class="page touch">
      <div class="page-head">
        <div><h1>My requests</h1><p>Live status of everything you asked for.</p></div>
        <a class="btn primary lg" routerLink="/request/new">＋ New request</a>
      </div>
      <scl-delay-banner />
      <div class="list">
        @for (t of tasks.mine(); track t.id) {
          <article class="card item" [class.done]="t.status === 'DELIVERED' || t.status === 'CANCELLED'">
            <div class="top">
              <strong>{{ name(t.from) }} → {{ name(t.to) }}</strong>
              <span class="chip" [class]="t.status === 'DELIVERED' ? 'ok' : t.status === 'CANCELLED' ? 'neutral' : 'info'">{{ statusLabel(t.status) }}</span>
            </div>
            <div class="muted">{{ t.item }} · {{ t.id }} · {{ t.priority }}</div>
            @if (t.status !== 'CANCELLED') { <scl-progress-steps [steps]="labels" [current]="stepIndex(t)" [finished]="t.status === 'DELIVERED'" /> }
            @if (t.status === 'DELIVERED' || t.status === 'CANCELLED') {
              <div class="row">
                <span class="muted">{{ t.status === 'DELIVERED' ? 'Delivered' : 'Cancelled' }}</span><span class="grow"></span>
                <a class="btn" routerLink="/request/new" [queryParams]="{ source: t.source, from: t.from, to: t.to, priority: t.priority }" title="Start a new request with the same details">↻ Request again</a>
              </div>
            }
            @if (t.status !== 'DELIVERED' && t.status !== 'CANCELLED') {
              <div class="row">
                <span>Arrives {{ eta(t) }}</span><span class="grow"></span>
                <a class="btn" [routerLink]="['/request/track', t.id]">Track</a>
                @if (canCancel(t)) { <button type="button" class="btn outline-danger" (click)="cancel(t)">Cancel</button> }
              </div>
            }
          </article>
        } @empty { <div class="empty card"><strong>No requests yet.</strong><span class="muted">Ask for a delivery and you can follow the robot here, step by step.</span><a class="btn primary" routerLink="/request/new">＋ Create your first request</a></div> }
      </div>
    </div>
  `,
  styles: [`
    .list { display: flex; flex-direction: column; gap: .7rem; max-width: 46rem; }
    .empty { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; padding: 1.4rem; }
    .item { padding: .9rem 1rem; display: flex; flex-direction: column; gap: .4rem; } .item.done { opacity: .75; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: .6rem; }
    .steps { list-style: none; display: flex; gap: 1rem; flex-wrap: wrap; padding: 0; margin: .1rem 0; font-size: .8rem; color: var(--text-faint); }
    .steps li.on { color: var(--text); font-weight: 600; }
  `],
})
export class MyRequestsPageComponent {
  protected readonly tasks = inject(TaskStore);
  private readonly facade = inject(OverrideFacade);
  protected readonly labels = STEPS.map((s) => s.label);

  protected name(id: string) { return stationName(id); }
  protected statusLabel(s: Task['status']) { return TASK_STATUS_LABEL[s]; }
  protected stepIndex(t: Task): number { return Math.max(0, STEPS.findIndex((s) => s.match.includes(t.status))); }
  protected eta(t: Task) { return humanEta(t.etaSec); }
  /** Staff may cancel their own request until the item has been picked up. */
  protected canCancel(t: Task) { return t.status === 'QUEUED' || t.status === 'TO_PICKUP' || t.status === 'ASSIGNED'; }
  protected cancel(t: Task) {
    return this.facade.run({ type: 'CANCEL_TASK', targetId: t.id, expectedVersion: t.version }, `Cancel request ${t.id}`, 'low', 'Cancel this request?');
  }
}

/** /request/track/:id — “Where is my delivery?” Single task, simplified map, plain language. */
@Component({
  selector: 'scl-track-delivery-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MapCanvasComponent, RouterLink, DelayBannerComponent, ProgressStepsComponent],
  template: `
    <div class="page touch">
      <div class="page-head">
        <div><h1>Where is my delivery?</h1><p>{{ task() ? task()!.id + ' · ' + task()!.item : 'Request not found' }}</p></div>
        <a class="btn" routerLink="/request/mine">← My requests</a>
      </div>
      <scl-delay-banner />
      @if (task(); as t) {
        <div class="status card">
          <div class="big">{{ headline() }}</div>
          @if (t.status !== 'CANCELLED') { <scl-progress-steps [steps]="labels" [current]="idx()" [finished]="t.status === 'DELIVERED'" /> }
          @if (t.status !== 'DELIVERED' && t.status !== 'CANCELLED') { <div class="muted">Estimated arrival {{ eta() }}</div> }
        </div>
        <div class="card mapcard"><scl-map-canvas mode="track" [trackTaskId]="t.id" /></div>
      } @else { <div class="empty card">This request is not available. <a routerLink="/request/mine">Back to my requests</a></div> }
    </div>
  `,
  styles: [`
    .status { padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: .4rem; max-width: 46rem; }
    .big { font-size: 1.35rem; font-weight: 800; }
    .steps { list-style: none; display: flex; gap: 1.1rem; flex-wrap: wrap; padding: 0; margin: 0; font-size: .85rem; color: var(--text-faint); }
    .steps li.on { color: var(--text); font-weight: 700; }
    .mapcard { height: min(60vh, 30rem); min-height: 18rem; overflow: hidden; }
  `],
})
export class TrackDeliveryPageComponent {
  readonly id = input<string>();
  private readonly tasks = inject(TaskStore);
  protected readonly labels = STEPS.map((s) => s.label);
  protected readonly task = computed(() => this.tasks.byId(this.id()));
  protected readonly idx = computed(() => {
    const t = this.task();
    return t ? Math.max(0, STEPS.findIndex((s) => s.match.includes(t.status))) : 0;
  });
  protected readonly eta = computed(() => humanEta(this.task()?.etaSec ?? null));
  protected readonly headline = computed(() => {
    switch (this.task()?.status) {
      case 'QUEUED': return 'Waiting for a robot';
      case 'ASSIGNED': case 'TO_PICKUP': return 'A robot is on its way to pick up';
      case 'IN_TRANSIT': return 'Your delivery is on the way';
      case 'DELIVERED': return 'Delivered ✔';
      case 'CANCELLED': return 'Request cancelled';
      default: return '';
    }
  });
}

/** /request/status — department queue overview + delay notices. */
@Component({
  selector: 'scl-department-status-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DelayBannerComponent, KpiMiniStripComponent, HasPermissionDirective],
  template: `
    <div class="page touch">
      <div class="page-head"><div><h1>Department status</h1><p>How busy transport is right now.</p></div></div>
      <scl-delay-banner />
      @if (!notices()) { <div class="banner info">✔ No delays expected at the moment.</div> }
      <div class="grid">
        @for (s of stations(); track s.id) {
          <article class="card st" [class.mine]="s.id === dept()">
            <strong>{{ s.name }}</strong>
            @if (s.id === dept()) { <span class="chip info">Your department</span> }
            <div class="num">{{ s.queue }}</div>
            <small class="muted">{{ s.queue === 1 ? 'request waiting' : 'requests waiting' }}</small>
          </article>
        }
      </div>
      <section *sclHasPermission="'kpi:view:basic'" class="col"><h2 class="panel-title">Throughput</h2><scl-kpi-mini-strip /></section>
    </div>
  `,
  styles: [`
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .7rem; }
    .st { padding: .8rem 1rem; display: flex; flex-direction: column; gap: .2rem; } .st.mine { border-color: var(--accent); }
    .num { font-size: 2rem; font-weight: 800; line-height: 1.1; }
  `],
})
export class DepartmentStatusPageComponent {
  private readonly fleet = inject(FleetStore);
  private readonly auth = inject(AuthService);
  private readonly insights = inject(InsightsStore);
  protected readonly dept = computed(() => this.auth.user().department);
  protected readonly notices = computed(() => this.insights.staffNotices().length);
  protected readonly stations = computed(() => this.fleet.stationList().filter((s) => s.kind !== 'CHARGING').map((s) => ({ ...s, name: stationName(s.id) })));
}

