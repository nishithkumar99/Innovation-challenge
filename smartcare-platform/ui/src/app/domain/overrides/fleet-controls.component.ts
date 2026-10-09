import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HasPermissionDirective } from '../../core/auth/permission.directive';
import { DialogService } from '../../core/layout/dialog.service';
import { MAP_EDGES, stationName } from '../../core/map-data';
import { RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { FleetStore } from '../fleet/fleet.store';
import { OverrideFacade } from './override.facade';

/** Fleet-wide controls (manager level): dispatch hold, dispatch mode, corridor blocks. */
@Component({
  selector: 'scl-fleet-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HasPermissionDirective],
  template: `
    <div class="bar" role="toolbar" aria-label="Fleet controls">
      <span class="panel-title">Fleet</span>
      <ng-container *sclHasPermission="'override:fleet'; else limited">
        @if (fleet.system().hold) {
          <button class="btn sm primary" [disabled]="!gw.canControl()" [attr.title]="reason()" (click)="resume()">▶ Resume dispatching</button>
        } @else {
          <button class="btn sm danger" [disabled]="!gw.canControl()" [attr.title]="reason()" (click)="hold()">⏸ Hold dispatching</button>
        }
        <button class="btn sm" [disabled]="!gw.canControl()" [attr.title]="reason()" (click)="toggleMode()">
          Mode: {{ fleet.system().mode === 'AUTO' ? 'Auto' : 'Semi-auto' }} ⇄
        </button>
        <button class="btn sm" [disabled]="!gw.canControl()" [attr.title]="reason()" (click)="block()">⛔ Block corridor…</button>
        @for (z of fleet.system().blockedZones; track z) {
          <button class="chip warn" type="button" [disabled]="!gw.canControl()" (click)="unblock(z)" [attr.title]="'Click to unblock'">
            ⛔ {{ zoneName(z) }} ✕
          </button>
        }
      </ng-container>
      <ng-template #limited><span class="faint">Fleet-wide controls require fleet-manager permission.</span></ng-template>
    </div>
  `,
  styles: [`
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
    button.chip { cursor: pointer; font: inherit; font-size: .72rem; }
  `],
})
export class FleetControlsComponent {
  protected readonly fleet = inject(FleetStore);
  protected readonly gw = inject(RealtimeGateway);
  private readonly facade = inject(OverrideFacade);
  private readonly dialogs = inject(DialogService);

  protected readonly reason = computed(() => (this.gw.canControl() ? null : 'Live data interrupted — controls disabled'));

  protected zoneName(id: string): string {
    const z = MAP_EDGES.find((e) => e.id === id);
    return z ? `${stationName(z.a)} ↔ ${stationName(z.b)}` : id;
  }
  protected hold() { return this.facade.run({ type: 'FLEET_HOLD' }, 'Hold all dispatching', 'critical', 'No new tasks will be assigned. Robots finish their current task.'); }
  protected resume() { return this.facade.run({ type: 'FLEET_RESUME' }, 'Resume dispatching', 'critical', 'Queued tasks will be assigned again.'); }
  protected toggleMode() {
    const next = this.fleet.system().mode === 'AUTO' ? 'SEMI_AUTO' : 'AUTO';
    return this.facade.run({ type: 'SET_MODE', params: { mode: next } }, `Switch to ${next === 'AUTO' ? 'auto' : 'semi-auto'} dispatch`, 'high',
      next === 'SEMI_AUTO' ? 'Only STAT tasks are dispatched automatically; others wait for an operator.' : 'The dispatcher assigns all tasks automatically.');
  }
  protected unblock(id: string) { return this.facade.run({ type: 'UNBLOCK_ZONE', targetId: id }, `Unblock ${this.zoneName(id)}`, 'high'); }

  protected async block(): Promise<void> {
    const r = await this.dialogs.open({
      title: 'Block corridor', message: 'Robots are re-routed around the blocked segment where an alternative exists.', confirmLabel: 'Continue',
      fields: [
        { key: 'zone', label: 'Corridor', type: 'select', options: MAP_EDGES.map((e) => ({ value: e.id, label: this.zoneName(e.id) })) },
        { key: 'dur', label: 'Duration', type: 'select', value: '120', options: [{ value: '60', label: '1 min' }, { value: '120', label: '2 min' }, { value: '300', label: '5 min' }, { value: '900', label: '15 min' }] },
      ],
    });
    if (r) await this.facade.run({ type: 'BLOCK_ZONE', targetId: r['zone'], params: { durationSec: Number(r['dur']) } }, `Block ${this.zoneName(r['zone'])}`, 'high');
  }
}
