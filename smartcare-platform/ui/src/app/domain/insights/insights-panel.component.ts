import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HasPermissionDirective } from '../../core/auth/permission.directive';
import { DialogService } from '../../core/layout/dialog.service';
import { NotificationService } from '../../core/layout/notification.service';
import { MAP_NODES } from '../../core/map-data';
import { CommandRequest, Insight, InsightSeverity } from '../../core/models';
import { ClockService, RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { FleetStore } from '../fleet/fleet.store';
import { UiStore } from '../fleet/ui.store';
import { OverrideFacade } from '../overrides/override.facade';
import { InsightsStore } from './insights.store';

const SEV: Record<InsightSeverity, { icon: string; label: string; cls: string }> = {
  CRITICAL: { icon: '●', label: 'CRITICAL', cls: 'crit' },
  WARNING: { icon: '▲', label: 'WARNING', cls: 'warn' },
  INFO: { icon: 'ℹ', label: 'INFO', cls: 'info' },
};

/** Bottleneck alerts + AI-suggested proactive actions (blueprint 1.4). */
@Component({
  selector: 'scl-insights-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HasPermissionDirective, NgTemplateOutlet],
  template: `
    <section class="panel" aria-label="Alerts and AI suggestions">
      <header>
        <h2 class="panel-title">Insights</h2>
        <div class="filters" role="group" aria-label="Filter by severity">
          @for (f of filters; track f) {
            <button type="button" class="btn sm" [class.primary]="store.filter().severity === f" (click)="store.setFilter(f)"
                    [attr.aria-pressed]="store.filter().severity === f">{{ f === 'ALL' ? 'All' : f[0] + f.slice(1).toLowerCase() }}</button>
          }
        </div>
        <button type="button" class="btn ghost sm" (click)="toast.muted.set(!toast.muted())" [attr.aria-pressed]="toast.muted()"
                [attr.title]="toast.muted() ? 'Unmute alert toasts' : 'Mute alert toasts'">{{ toast.muted() ? '🔕' : '🔔' }}</button>
      </header>

      @if (!fleet.system().aiAvailable) {
        <div class="banner warn" role="status">⚠ AI insights unavailable — core map and overrides are unaffected.</div>
      }

      <div class="list">
        @if (store.pinned().length) { <div class="sect">Acknowledged</div> }
        @for (i of store.pinned(); track i.id) { <ng-container *ngTemplateOutlet="card; context: { $implicit: i }" /> }
        @if (store.pinned().length && store.unpinned().length) { <div class="sect">Open</div> }
        @for (i of store.unpinned(); track i.id) { <ng-container *ngTemplateOutlet="card; context: { $implicit: i }" /> }
        @if (!store.visible().length) {
          <div class="empty">✔ No open bottlenecks.<br /><small>Predictions refresh every few seconds.</small></div>
        }
        @if (store.recent().length) {
          <details class="recent">
            <summary>Recently handled ({{ store.recent().length }})</summary>
            @for (i of store.recent(); track i.id) {
              <div class="rec"><span class="chip neutral">{{ i.state.replace('_', ' ') }}</span> {{ i.title }}</div>
            }
          </details>
        }
      </div>
    </section>

    <ng-template #card let-i>
      @let sev = sevMeta(i.severity);
      <article class="ins" [class]="sev.cls" (mouseenter)="ui.highlightZoneId.set(i.zoneId)" (mouseleave)="ui.highlightZoneId.set(null)"
               (focusin)="ui.highlightZoneId.set(i.zoneId)" (focusout)="ui.highlightZoneId.set(null)">
        <div class="top">
          <span class="chip" [class]="sev.cls">{{ sev.icon }} {{ sev.label }}</span>
          <span class="faint ttl" [attr.title]="'Valid until the prediction window closes'">⏱ {{ ttl(i) }}</span>
        </div>
        <h3>{{ i.title }}</h3>
        <div class="meta">ETA +{{ i.etaMin }} min · confidence {{ (i.confidence * 100).toFixed(0) }} % · affects {{ i.affectedTasks }} tasks</div>

        @if (i.suggestion; as s) {
          <div class="sugg">
            <div class="s-title">▸ {{ s.label }}</div>
            <div class="faint">Expected impact: −{{ s.impactMin }} min avg wait</div>
            <div class="acts" *sclHasPermission="'insight:act'; else ro">
              <button type="button" class="btn primary sm" [disabled]="store.pending().has(i.id) || !gw.canControl()"
                      [attr.title]="!gw.canControl() ? 'Live data interrupted' : null" (click)="store.apply(i)">
                {{ store.pending().has(i.id) ? 'Applying…' : 'Apply' }}
              </button>
              <button type="button" class="btn sm" [disabled]="store.pending().has(i.id) || !gw.canControl()" (click)="modify(i)">Modify…</button>
              <button type="button" class="btn ghost sm" [disabled]="store.pending().has(i.id)" (click)="dismiss(i)">Dismiss…</button>
            </div>
            <ng-template #ro><div class="faint">View only — operators can apply suggestions.</div></ng-template>
          </div>
        } @else {
          <div class="acts" *sclHasPermission="'insight:act'">
            <button type="button" class="btn ghost sm" (click)="dismiss(i)">Dismiss…</button>
          </div>
        }

        <div class="links">
          @if (i.zoneId) { <button type="button" class="link" (click)="ui.showZone(i.zoneId)">Show on map</button> }
          @if (i.state !== 'ACKNOWLEDGED') {
            <button *sclHasPermission="'insight:act'" type="button" class="link" (click)="store.acknowledge(i)">Acknowledge</button>
          }
        </div>
      </article>
    </ng-template>
  `,
  styles: [`
    :host { display: block; height: 100%; min-height: 0; }
    .panel { height: 100%; display: flex; flex-direction: column; min-height: 0; }
    header { display: flex; align-items: center; gap: .5rem; padding: .6rem .75rem .4rem; }
    header h2 { flex: 1; }
    .filters { display: flex; gap: .25rem; }
    .banner { margin: 0 .6rem .4rem; }
    .list { overflow-y: auto; padding: 0 .6rem .6rem; display: flex; flex-direction: column; gap: .5rem; min-height: 0; }
    .sect { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-faint); margin-top: .2rem; }
    .ins { border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; padding: .55rem .7rem; background: var(--surface-2); display: flex; flex-direction: column; gap: .25rem; }
    .ins.crit { border-left-color: var(--crit); } .ins.warn { border-left-color: var(--warn); } .ins.info { border-left-color: var(--info); }
    .top { display: flex; justify-content: space-between; align-items: center; }
    h3 { font-size: .88rem; margin: 0; }
    .meta { font-size: .75rem; color: var(--text-dim); }
    .sugg { background: var(--surface); border: 1px dashed var(--border); border-radius: 8px; padding: .45rem .55rem; display: flex; flex-direction: column; gap: .2rem; margin-top: .2rem; }
    .s-title { font-weight: 700; font-size: .85rem; }
    .acts { display: flex; gap: .35rem; flex-wrap: wrap; margin-top: .25rem; }
    .links { display: flex; gap: .9rem; }
    .link { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; font-size: .78rem; cursor: pointer; }
    .link:hover { text-decoration: underline; }
    .ttl { font-size: .72rem; }
    .recent { font-size: .75rem; color: var(--text-dim); margin-top: .3rem; }
    .rec { padding: .15rem 0; display: flex; gap: .4rem; align-items: center; }
  `],
})
export class InsightsPanelComponent {
  protected readonly store = inject(InsightsStore);
  protected readonly fleet = inject(FleetStore);
  protected readonly ui = inject(UiStore);
  protected readonly gw = inject(RealtimeGateway);
  protected readonly toast = inject(NotificationService);
  private readonly dialogs = inject(DialogService);
  private readonly facade = inject(OverrideFacade);
  private readonly clock = inject(ClockService);

  protected readonly filters: ('ALL' | InsightSeverity)[] = ['ALL', 'CRITICAL', 'WARNING', 'INFO'];
  protected sevMeta(s: InsightSeverity) { return SEV[s]; }

  protected ttl(i: Insight): string {
    this.fleet.tick();
    const sec = Math.max(0, Math.round((i.validUntil - this.clock.now()) / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  /** Pre-filled dialog: operator can adjust the AI's proposal before sending it as a manual command. */
  protected async modify(i: Insight): Promise<void> {
    const s = i.suggestion;
    if (!s) return;
    const robots = this.fleet.robotViews().filter((r) => !r.taskId && r.viewStatus === 'IDLE');
    let cmd: CommandRequest;
    if (s.command.type === 'GOTO') {
      const r = await this.dialogs.open({
        title: 'Modify suggested action', message: s.label, confirmLabel: 'Send as manual command',
        fields: [
          { key: 'robot', label: 'Robot', type: 'select', options: (robots.length ? robots : this.fleet.robotViews()).map((x) => ({ value: x.id, label: x.name })), value: String(s.command.targetId) },
          { key: 'node', label: 'Target waypoint', type: 'select', options: MAP_NODES.filter((n) => n.kind !== 'CHARGING').map((n) => ({ value: n.id, label: n.name })), value: String(s.command.params?.['nodeId']) },
        ],
      });
      if (!r) return;
      cmd = { type: 'GOTO', targetId: r['robot'], params: { nodeId: r['node'] } };
    } else {
      const r = await this.dialogs.open({
        title: 'Modify suggested action', message: s.label, confirmLabel: 'Send as manual command',
        fields: [{ key: 'dur', label: 'Block duration', type: 'select', value: '120', options: [{ value: '60', label: '1 min' }, { value: '120', label: '2 min' }, { value: '300', label: '5 min' }] }],
      });
      if (!r) return;
      cmd = { type: 'BLOCK_ZONE', targetId: s.command.targetId, params: { durationSec: Number(r['dur']) } };
    }
    await this.facade.run(cmd, 'Manual action (from AI suggestion)', 'medium', s.label);
  }

  protected async dismiss(i: Insight): Promise<void> {
    const r = await this.dialogs.open({
      title: 'Dismiss insight', message: i.title, confirmLabel: 'Dismiss',
      fields: [{
        key: 'reason', label: 'Why? (feedback for the AI layer)', type: 'select', required: true, value: 'not-relevant',
        options: [
          { value: 'not-relevant', label: 'Not relevant' }, { value: 'handled', label: 'Already handled' },
          { value: 'inaccurate', label: 'Prediction looks wrong' }, { value: 'other', label: 'Other' },
        ],
      }],
    });
    if (r) await this.store.dismiss(i, r['reason']);
  }
}

