import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HasPermissionDirective } from '../../core/auth/permission.directive';
import { TaskSource } from '../../core/models';
import { UiStore } from '../fleet/ui.store';
import { EntityDetailPanelComponent } from '../overrides/entity-detail-panel.component';
import { TaskFormComponent } from './task-form.component';
import { TaskQueueTableComponent } from './task-queue-table.component';
import { SOURCES } from './task-templates';

/** /tasks — full queue with live patching + detail/actions side panel. */
@Component({
  selector: 'scl-tasks-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TaskQueueTableComponent, EntityDetailPanelComponent, RouterLink, HasPermissionDirective],
  template: `
    <div class="page wide">
      <div class="page-head">
        <div><h1>Tasks</h1><p>Live queue across all departments. Select a row for its timeline and actions.</p></div>
        <a *sclHasPermission="'task:create'" class="btn primary" routerLink="/tasks/new">＋ New task</a>
      </div>
      <div class="split">
        <section class="card list"><scl-task-queue-table /></section>
        <section class="card side"><scl-entity-detail /></section>
      </div>
    </div>
  `,
  styles: [`
    .wide { max-width: none; height: 100%; min-height: 0; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 24rem; gap: .8rem; flex: 1; min-height: 32rem; }
    .list, .side { min-height: 0; overflow: hidden; }
    @media (max-width: 1000px) { .split { grid-template-columns: 1fr; } .list { height: 30rem; } .side { min-height: 22rem; } }
  `],
})
export class TasksPageComponent {
  protected readonly ui = inject(UiStore);
}

/** /tasks/new — operator-side task creation with source launch pads. */
@Component({
  selector: 'scl-task-create-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TaskFormComponent, RouterLink],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>New task</h1><p>Create a transport request on behalf of a department.</p></div>
        <a class="btn ghost" routerLink="/tasks">← Back to queue</a>
      </div>
      <div class="cols">
        <div class="pads" role="radiogroup" aria-label="Source">
          @for (s of sources; track s.source) {
            <button type="button" role="radio" class="pad card" [class.on]="selected() === s.source" [attr.aria-checked]="selected() === s.source" (click)="selected.set(s.source)">
              <span class="ic">{{ s.icon }}</span><strong>{{ s.label }}</strong><small>{{ s.blurb }}</small>
            </button>
          }
        </div>
        <div class="card formcard"><scl-task-form [source]="selected()" /></div>
      </div>
    </div>
  `,
  styles: [`
    .cols { display: grid; grid-template-columns: 17rem minmax(0, 1fr); gap: 1rem; align-items: start; }
    .pads { display: flex; flex-direction: column; gap: .5rem; }
    .pad { text-align: left; cursor: pointer; padding: .7rem .9rem; display: grid; grid-template-columns: 2rem 1fr; column-gap: .6rem; color: var(--text); font: inherit; }
    .pad .ic { grid-row: span 2; font-size: 1.4rem; } .pad small { color: var(--text-dim); }
    .pad.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .formcard { padding: 1rem 1.1rem; }
    @media (max-width: 800px) { .cols { grid-template-columns: 1fr; } .pads { flex-direction: row; overflow-x: auto; } .pad { min-width: 12rem; } }
  `],
})
export class TaskCreatePageComponent {
  readonly source = input<string>();
  protected readonly sources = SOURCES;
  protected readonly selected = signal<TaskSource>('PHARMACY');

  constructor() {
    effect(() => {
      const s = this.source();
      if (s && SOURCES.some((x) => x.source === s)) this.selected.set(s as TaskSource);
    });
  }
}
