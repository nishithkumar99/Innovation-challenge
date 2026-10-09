import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HasPermissionDirective } from '../../core/auth/permission.directive';
import { DialogService } from '../../core/layout/dialog.service';
import { stationName } from '../../core/map-data';
import { TaskPriority } from '../../core/models';
import { RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { HoldToConfirmComponent } from '../../shared/ui/hold-to-confirm.component';
import {
  DurationPipe, ROBOT_STATUS_COLOR, ROBOT_STATUS_ICON, ROBOT_STATUS_LABEL, TASK_STATUS_LABEL,
} from '../../shared/util';
import { FleetStore } from '../fleet/fleet.store';
import { UiStore } from '../fleet/ui.store';
import { TaskStore } from '../tasks/task.store';
import { CommandRecord, CommandTrackerStore } from './command-tracker.store';
import { OverrideFacade } from './override.facade';

const CMD_CLASS: Record<CommandRecord['state'], string> = {
  SENT: 'info', ACCEPTED: 'info', EXECUTING: 'info', DONE: 'ok', REJECTED: 'crit', TIMED_OUT: 'warn',
};
const CMD_ICON: Record<CommandRecord['state'], string> = {
  SENT: '…', ACCEPTED: '…', EXECUTING: '⟳', DONE: '✔', REJECTED: '✖', TIMED_OUT: '?',
};

/** Selected entity (robot / task) + manual override controls (blueprint 1.5). */
@Component({
  selector: 'scl-entity-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HasPermissionDirective, HoldToConfirmComponent, DurationPipe, NgTemplateOutlet],
  template: `
    <section class="detail">
      @if (robot(); as r) {
        <header>
          <div>
            <h2>{{ r.name }}</h2>
            <span class="chip" [style.--c]="color(r.viewStatus)">{{ icon(r.viewStatus) }} {{ label(r.viewStatus) }}</span>
          </div>
          <button type="button" class="btn ghost sm" (click)="ui.select(null)" aria-label="Close details">✕</button>
        </header>

        <div class="bat" [class.low]="r.battery < 25" [class.mid]="r.battery >= 25 && r.battery < 50">
          <span>Battery {{ r.battery.toFixed(0) }} %</span>
          <div class="progress" [class.low]="r.battery < 25" [class.mid]="r.battery >= 25 && r.battery < 50"><i [style.width.%]="r.battery"></i></div>
        </div>
        <dl>
          <dt>Speed</dt><dd>{{ r.speed.toFixed(1) }} u/s</dd>
          <dt>Position</dt><dd>{{ r.pos.x.toFixed(1) }}, {{ r.pos.y.toFixed(1) }}</dd>
          <dt>Task</dt>
          <dd>@if (task(); as t) { <button class="link" type="button" (click)="ui.select({ kind: 'task', id: t.id })">{{ t.id }}</button> } @else { — }</dd>
          <dt>Telemetry</dt><dd>{{ r.stale ? 'No signal' : 'Live' }}</dd>
        </dl>

        <div class="grp">
          <div class="panel-title">Overrides</div>
          @if (block(); as b) { <div class="banner warn">⚠ {{ b }}</div> }
          <div class="acts" *sclHasPermission="'override:robot'; else readonly">
            @if (r.status === 'PAUSED') {
              <button class="btn sm" [disabled]="!!block()" [attr.title]="block()" (click)="simple('RESUME', 'Resume ' + r.name, 'medium')">▶ Resume</button>
            } @else {
              <button class="btn sm" [disabled]="!!block() || r.status === 'FAULT' || r.status === 'MANUAL_OVERRIDE'" [attr.title]="block() ?? holdReason(r.status)"
                      (click)="simple('PAUSE', 'Pause ' + r.name, 'medium')">❚❚ Pause</button>
            }
            <button class="btn sm" [disabled]="!!block() || !!r.taskId || r.status === 'CHARGING' || r.status === 'FAULT'" [attr.title]="block() ?? (r.taskId ? 'Robot has an active task' : null)"
                    (click)="simple('CHARGE', 'Send ' + r.name + ' to charging', 'medium')">⚡ Charge</button>
            <button class="btn sm" [disabled]="!!block() || !!r.taskId || r.status === 'FAULT'" [attr.title]="block() ?? (r.taskId ? 'Robot has an active task' : null)"
                    (click)="ui.pick.set({ kind: 'goto', robotId: r.id })">⌖ Reroute…</button>
            @if (r.status === 'MANUAL_OVERRIDE') {
              <button class="btn sm" [disabled]="!!block()" (click)="simple('RELEASE_MANUAL', 'Release manual control of ' + r.name, 'medium')">Release manual</button>
            } @else {
              <button class="btn sm" [disabled]="!!block() || r.status === 'FAULT' || r.status === 'PAUSED'" (click)="simple('TAKE_MANUAL', 'Take manual control of ' + r.name, 'high', 'The dispatcher stops commanding this robot until you release it.')">✋ Take manual</button>
            }
            @if (r.status === 'FAULT') {
              <button class="btn sm" [disabled]="!!block()" (click)="simple('RESET', 'Reset fault on ' + r.name, 'high', 'Only reset after the robot has been checked on site.')">↺ Reset fault</button>
            }
            <button class="btn sm" (click)="ui.followRobotId.set(ui.followRobotId() === r.id ? null : r.id)" [attr.aria-pressed]="ui.followRobotId() === r.id">
              {{ ui.followRobotId() === r.id ? '◉ Following' : '◎ Follow' }}
            </button>
          </div>
          <ng-template #readonly><div class="faint">View only.</div></ng-template>
          <div *sclHasPermission="'override:estop'" class="estop">
            <scl-hold-to-confirm label="⛔ Emergency stop (hold)" [disabled]="r.status === 'FAULT' || !gw.canControl()"
              [disabledReason]="r.status === 'FAULT' ? 'Already in E-stop' : 'Live data interrupted'" (confirmed)="estop(r.id, r.name)" />
          </div>
        </div>

        <div class="grp">
          <div class="panel-title">Command log</div>
          <ng-container *ngTemplateOutlet="log" />
        </div>
      } @else if (task(); as t) {
        <header>
          <div>
            <h2>{{ t.id }}</h2>
            <span class="chip" [class]="t.priority === 'STAT' ? 'crit' : t.priority === 'URGENT' ? 'warn' : 'neutral'">{{ t.priority }}</span>
            <span class="chip info">{{ statusLabel(t.status) }}</span>
            @if (t.origin === 'SIMULATED') { <span class="chip warn">SIMULATED</span> }
          </div>
          <button type="button" class="btn ghost sm" (click)="ui.select(null)" aria-label="Close details">✕</button>
        </header>
        <dl>
          <dt>Route</dt><dd>{{ name(t.from) }} → {{ name(t.to) }}</dd>
          <dt>Item</dt><dd>{{ t.item }}</dd>
          <dt>Requester</dt><dd>{{ t.requesterName }}</dd>
          <dt>Robot</dt>
          <dd>@if (t.robotId) { <button class="link" type="button" (click)="ui.select({ kind: 'robot', id: t.robotId })">{{ t.robotId }}</button> } @else { — }</dd>
          <dt>ETA</dt><dd>{{ t.etaSec | duration }}</dd>
        </dl>

        <div class="grp">
          <div class="panel-title">Timeline</div>
          <ol class="tl">
            @for (s of timeline(); track s.label) {
              <li [class.done]="!!s.at"><span class="dot">{{ s.at ? '✔' : '○' }}</span> {{ s.label }}<span class="faint">{{ s.at ? time(s.at) : '' }}</span></li>
            }
          </ol>
        </div>

        <div class="grp" *sclHasPermission="'task:modify:any'">
          <div class="panel-title">Task actions</div>
          <div class="acts">
            <button class="btn sm" [disabled]="!!taskBlock()" [attr.title]="taskBlock()" (click)="setPriority()">⇅ Priority…</button>
            <button class="btn sm" [disabled]="!!taskBlock() || t.status === 'IN_TRANSIT'" [attr.title]="taskBlock() ?? (t.status === 'IN_TRANSIT' ? 'Task already in transit' : null)" (click)="reassign()">⇄ Reassign…</button>
            <button class="btn outline-danger sm" [disabled]="!!taskBlock() || t.status === 'IN_TRANSIT'" [attr.title]="taskBlock() ?? (t.status === 'IN_TRANSIT' ? 'Task already in transit' : null)" (click)="cancel()">✖ Cancel task</button>
          </div>
        </div>
        <div class="grp">
          <div class="panel-title">Command log</div>
          <ng-container *ngTemplateOutlet="log" />
        </div>
      } @else {
        <div class="empty">Select a robot on the map or a task in the queue to see details and controls.</div>
      }
    </section>

    <ng-template #log>
      <div class="hist">
        @for (h of history(); track h.id) {
          <div>
            <span class="chip" [class]="cmdClass(h.state)">{{ cmdIcon(h.state) }} {{ h.state.replace('_', ' ') }}</span>
            <span>{{ h.label }}</span>
            @if (h.reason && h.state !== 'DONE') { <span class="faint">— {{ h.reason }}</span> }
          </div>
        } @empty { <span class="faint">No commands yet.</span> }
      </div>
    </ng-template>
  `,
  styles: [`
    :host { display: block; height: 100%; min-height: 0; }
    .detail { height: 100%; overflow-y: auto; padding: .7rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: .5rem; }
    header h2 { font-size: 1.05rem; margin-bottom: .2rem; }
    header .chip { margin-right: .25rem; }
    dl { display: grid; grid-template-columns: 5.5rem 1fr; gap: .2rem .6rem; margin: 0; font-size: .82rem; }
    dt { color: var(--text-faint); } dd { margin: 0; }
    .grp { display: flex; flex-direction: column; gap: .4rem; }
    .acts { display: flex; flex-wrap: wrap; gap: .35rem; }
    .estop { margin-top: .2rem; }
    .link { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; cursor: pointer; }
    .tl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; font-size: .82rem; }
    .tl li { display: flex; gap: .5rem; color: var(--text-faint); } .tl li.done { color: var(--text); }
    .tl .faint { margin-left: auto; } .dot { width: 1rem; text-align: center; }
    .hist { display: flex; flex-direction: column; gap: .25rem; font-size: .78rem; }
    .hist div { display: flex; gap: .4rem; align-items: baseline; }
    .banner { padding: .35rem .6rem; font-size: .78rem; }
  `],
})
export class EntityDetailPanelComponent {
  protected readonly ui = inject(UiStore);
  protected readonly gw = inject(RealtimeGateway);
  private readonly fleet = inject(FleetStore);
  private readonly tasks = inject(TaskStore);
  private readonly tracker = inject(CommandTrackerStore);
  private readonly facade = inject(OverrideFacade);
  private readonly dialogs = inject(DialogService);

  protected readonly robot = computed(() => {
    const s = this.ui.selection();
    return s?.kind === 'robot' ? this.fleet.robotViewById()[s.id] ?? null : null;
  });
  protected readonly task = computed(() => {
    const s = this.ui.selection();
    if (s?.kind === 'task') return this.tasks.byId(s.id) ?? null;
    const r = this.robot();
    return r ? this.tasks.forRobot(r.id) ?? null : null;
  });
  protected readonly block = computed(() => {
    if (!this.gw.canControl()) return 'Live data interrupted — controls disabled.';
    return this.robot()?.stale ? 'No telemetry — robot state unknown.' : null;
  });
  protected readonly taskBlock = computed(() => {
    const t = this.task();
    if (!this.gw.canControl()) return 'Live data interrupted — controls disabled.';
    return !t || ['DELIVERED', 'CANCELLED'].includes(t.status) ? 'Task already finished' : null;
  });
  protected readonly history = computed(() => {
    const s = this.ui.selection();
    return s ? this.tracker.forTarget(s.id).slice(0, 6) : [];
  });
  protected readonly timeline = computed(() => {
    const t = this.task();
    return t ? [
      { label: 'Created', at: t.createdAt }, { label: 'Assigned', at: t.assignedAt }, { label: 'Picked up', at: t.pickedAt }, { label: t.status === 'CANCELLED' ? 'Cancelled' : 'Delivered', at: t.deliveredAt ?? (t.status === 'CANCELLED' ? Date.now() : undefined) },
    ] : [];
  });

  protected color(s: keyof typeof ROBOT_STATUS_COLOR) { return ROBOT_STATUS_COLOR[s]; }
  protected icon(s: keyof typeof ROBOT_STATUS_ICON) { return ROBOT_STATUS_ICON[s]; }
  protected label(s: keyof typeof ROBOT_STATUS_LABEL) { return ROBOT_STATUS_LABEL[s]; }
  protected statusLabel(s: keyof typeof TASK_STATUS_LABEL) { return TASK_STATUS_LABEL[s]; }
  protected name(id: string) { return stationName(id); }
  protected time(ts: number) { return new Date(ts).toLocaleTimeString('de-DE'); }
  protected cmdClass(s: CommandRecord['state']) { return CMD_CLASS[s]; }
  protected cmdIcon(s: CommandRecord['state']) { return CMD_ICON[s]; }
  protected holdReason(status: string) { return status === 'FAULT' ? 'Robot is in fault state' : status === 'MANUAL_OVERRIDE' ? 'Robot is under manual control' : null; }

  protected simple(type: 'PAUSE' | 'RESUME' | 'CHARGE' | 'TAKE_MANUAL' | 'RELEASE_MANUAL' | 'RESET', label: string, risk: 'medium' | 'high', msg?: string): void {
    const r = this.robot();
    if (r) void this.facade.run({ type, targetId: r.id }, label, risk, msg);
  }

  protected estop(id: string, name: string): void {
    void this.facade.run({ type: 'ESTOP', targetId: id }, `Emergency stop ${name}`, 'high', 'The robot stops immediately and stays in fault until reset on site.');
  }

  protected async setPriority(): Promise<void> {
    const t = this.task();
    if (!t) return;
    const r = await this.dialogs.open({
      title: `Change priority of ${t.id}`, confirmLabel: 'Change priority',
      fields: [
        { key: 'p', label: 'New priority', type: 'select', value: t.priority, options: (['STAT', 'URGENT', 'ROUTINE'] as TaskPriority[]).map((p) => ({ value: p, label: p })) },
        { key: 'reason', label: 'Reason', type: 'text', required: true, placeholder: 'e.g. clinical priority change' },
      ],
    });
    if (r) await this.facade.submit({ type: 'SET_PRIORITY', targetId: t.id, params: { priority: r['p'] }, reason: r['reason'], expectedVersion: t.version }, `Set ${t.id} to ${r['p']}`);
  }

  protected async reassign(): Promise<void> {
    const t = this.task();
    if (!t) return;
    const idle = this.fleet.robotViews().filter((r) => r.viewStatus === 'IDLE' && !r.taskId && r.battery >= 25);
    if (!idle.length) { await this.dialogs.confirm('No robot available', 'There is no idle robot with enough battery right now.', 'OK'); return; }
    const r = await this.dialogs.open({
      title: `Reassign ${t.id}`, confirmLabel: 'Reassign',
      fields: [
        { key: 'robot', label: 'Robot', type: 'select', value: idle[0].id, options: idle.map((x) => ({ value: x.id, label: `${x.name} · ${x.battery.toFixed(0)} %` })) },
        { key: 'reason', label: 'Reason', type: 'text', required: true },
      ],
    });
    if (r) await this.facade.submit({ type: 'REASSIGN', targetId: t.id, params: { robotId: r['robot'] }, reason: r['reason'], expectedVersion: t.version }, `Reassign ${t.id} to ${r['robot']}`);
  }

  protected async cancel(): Promise<void> {
    const t = this.task();
    if (t) await this.facade.run({ type: 'CANCEL_TASK', targetId: t.id, expectedVersion: t.version }, `Cancel ${t.id}`, 'medium', 'The requester will be notified.');
  }
}
