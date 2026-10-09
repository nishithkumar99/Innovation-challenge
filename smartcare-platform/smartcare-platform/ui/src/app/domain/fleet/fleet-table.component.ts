import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DurationPipe, ROBOT_STATUS_COLOR, ROBOT_STATUS_ICON, ROBOT_STATUS_LABEL } from '../../shared/util';
import { TaskStore } from '../tasks/task.store';
import { FleetStore } from './fleet.store';
import { UiStore } from './ui.store';

/** Accessible list equivalent of the map (blueprint 4.8: parallel list view for non-visual users). */
@Component({
  selector: 'scl-fleet-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DurationPipe],
  template: `
    <div class="scroll">
      <table class="grid" aria-label="Fleet">
        <thead><tr><th>Robot</th><th>Status</th><th>Battery</th><th>Task</th><th>ETA</th><th>Telemetry</th></tr></thead>
        <tbody>
          @for (r of fleet.robotViews(); track r.id) {
            <tr class="clickable" [class.selected]="ui.selection()?.id === r.id" (click)="ui.select({ kind: 'robot', id: r.id })" tabindex="0"
                (keydown.enter)="ui.select({ kind: 'robot', id: r.id })">
              <td><strong>{{ r.name }}</strong></td>
              <td><span class="chip" [style.--c]="color(r.viewStatus)">{{ icon(r.viewStatus) }} {{ label(r.viewStatus) }}</span></td>
              <td>
                <span [style.color]="r.battery < 25 ? 'var(--danger)' : null">{{ r.battery.toFixed(0) }} %</span>
              </td>
              <td>{{ r.taskId ?? '—' }}</td>
              <td>{{ etaOf(r.taskId) | duration }}</td>
              <td>{{ r.stale ? '✖ no signal' : '✔ live' }}</td>
            </tr>
          } @empty { <tr><td colspan="6" class="empty">No robots reporting.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
  styles: [`:host { display: block; height: 100%; } .scroll { height: 100%; overflow: auto; }`],
})
export class FleetTableComponent {
  protected readonly fleet = inject(FleetStore);
  protected readonly ui = inject(UiStore);
  private readonly tasks = inject(TaskStore);

  protected color(s: keyof typeof ROBOT_STATUS_COLOR) { return ROBOT_STATUS_COLOR[s]; }
  protected icon(s: keyof typeof ROBOT_STATUS_ICON) { return ROBOT_STATUS_ICON[s]; }
  protected label(s: keyof typeof ROBOT_STATUS_LABEL) { return ROBOT_STATUS_LABEL[s]; }
  protected etaOf(id: string | null) { return this.tasks.byId(id)?.etaSec ?? null; }
}
