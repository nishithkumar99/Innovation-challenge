import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { HorizonMin } from '../../core/models';
import { stationName } from '../../core/map-data';
import { InsightsPanelComponent } from '../insights/insights-panel.component';
import { KpiMiniStripComponent } from '../kpi/kpi-mini-strip.component';
import { EntityDetailPanelComponent } from '../overrides/entity-detail-panel.component';
import { FleetControlsComponent } from '../overrides/fleet-controls.component';
import { OverrideFacade } from '../overrides/override.facade';
import { TaskQueueTableComponent } from '../tasks/task-queue-table.component';
import { FleetSummaryComponent } from './fleet-summary.component';
import { FleetTableComponent } from './fleet-table.component';
import { MapCanvasComponent } from './map-canvas.component';
import { MapLayers, UiStore } from './ui.store';

/** Operator control center: map + insights + selected entity + bottom dock (blueprint 1.2). */
@Component({
  selector: 'scl-ops-workspace',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MapCanvasComponent, InsightsPanelComponent, EntityDetailPanelComponent, FleetControlsComponent, TaskQueueTableComponent, FleetTableComponent, KpiMiniStripComponent, FleetSummaryComponent],
  template: `
    <div class="ops">
      <div class="toolbar card"><scl-fleet-summary /><scl-fleet-controls /></div>

      <section class="map card" aria-label="Live map">
        <div class="map-bar">
          <div class="layers" role="group" aria-label="Map layers">
            @for (l of layerDefs; track l.key) {
              <button type="button" class="btn sm" [class.primary]="ui.layers()[l.key]" [attr.aria-pressed]="ui.layers()[l.key]" (click)="ui.toggleLayer(l.key)">{{ l.label }}</button>
            }
          </div>
          <div class="hz" role="radiogroup" aria-label="Prediction horizon">
            <span class="faint">Prediction</span>
            @for (h of horizons; track h) {
              <button type="button" class="btn sm" role="radio" [class.primary]="ui.horizon() === h" [attr.aria-checked]="ui.horizon() === h" (click)="ui.horizon.set(h)">+{{ h }} min</button>
            }
          </div>
        </div>
        <div class="canvas"><scl-map-canvas (nodePicked)="picked($event)" /></div>
      </section>

      <aside class="rail">
        <div class="card insights"><scl-insights-panel /></div>
        <div class="card detail"><scl-entity-detail /></div>
      </aside>

      <section class="dock card" aria-label="Details dock">
        <div class="tabs" role="tablist">
          @for (t of tabs; track t.id) {
            <button type="button" role="tab" class="tab" [class.on]="ui.dockTab() === t.id" [attr.aria-selected]="ui.dockTab() === t.id" (click)="ui.dockTab.set(t.id)">{{ t.label }}</button>
          }
        </div>
        <div class="tabbody" role="tabpanel">
          @switch (ui.dockTab()) {
            @case ('tasks') { <scl-task-queue-table /> }
            @case ('fleet') { <scl-fleet-table /> }
            @case ('kpi') { <div class="kpi"><scl-kpi-mini-strip /></div> }
          }
        </div>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; flex: 1; min-height: 0; }
    .ops { height: 100%; padding: .6rem; display: grid; gap: .6rem; grid-template-columns: minmax(0, 1fr) 23rem; grid-template-rows: auto minmax(0, 1fr) 15.5rem; min-height: 34rem; }
    .toolbar { grid-column: 1 / -1; padding: .45rem .7rem; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .4rem 1.2rem; }
    .map { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    .map-bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .4rem .8rem; padding: .45rem .6rem; border-bottom: 1px solid var(--border); }
    .layers, .hz { display: flex; gap: .25rem; align-items: center; flex-wrap: wrap; }
    .canvas { flex: 1; min-height: 0; position: relative; }
    .rail { grid-row: 2 / 4; grid-column: 2; display: grid; grid-template-rows: minmax(0, 3fr) minmax(0, 2fr); gap: .6rem; min-height: 0; }
    .rail .card { min-height: 0; overflow: hidden; }
    .dock { grid-column: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    .tabs { display: flex; gap: .25rem; padding: .3rem .5rem 0; border-bottom: 1px solid var(--border); }
    .tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--text-dim); font: inherit; font-weight: 700; padding: .4rem .8rem; cursor: pointer; }
    .tab.on { color: var(--text); border-bottom-color: var(--accent); }
    .tabbody { flex: 1; min-height: 0; padding-top: .2rem; }
    .kpi { padding: .6rem; overflow: auto; height: 100%; }
    @media (max-width: 1100px) {
      .ops { grid-template-columns: 1fr; grid-template-rows: auto 26rem auto 22rem; height: auto; }
      .rail { grid-row: auto; grid-column: 1; grid-template-rows: 24rem 20rem; }
      .dock { grid-column: 1; }
    }
  `],
})
export class OpsWorkspaceComponent {
  protected readonly ui = inject(UiStore);
  private readonly facade = inject(OverrideFacade);

  protected readonly horizons: HorizonMin[] = [5, 15, 30];
  protected readonly tabs = [{ id: 'tasks', label: 'Task queue' }, { id: 'fleet', label: 'Fleet' }, { id: 'kpi', label: 'KPIs' }] as const;
  protected readonly layerDefs: { key: keyof MapLayers; label: string }[] = [
    { key: 'heat', label: 'Predictions' }, { key: 'congestionNow', label: 'Traffic' }, { key: 'routes', label: 'Routes' },
    { key: 'navGraph', label: 'Nav graph' }, { key: 'stations', label: 'Stations' }, { key: 'labels', label: 'Labels' },
  ];

  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === 'Escape') { this.ui.pick.set(null); this.ui.select(null); this.ui.followRobotId.set(null); }
    if (ev.key.toLowerCase() === 'f') {
      const s = this.ui.selection();
      if (s?.kind === 'robot') this.ui.followRobotId.set(this.ui.followRobotId() === s.id ? null : s.id);
    }
  }

  protected async picked(nodeId: string): Promise<void> {
    const p = this.ui.pick();
    if (!p) return;
    this.ui.pick.set(null);
    await this.facade.run({ type: 'GOTO', targetId: p.robotId, params: { nodeId } }, `Send ${p.robotId} to ${stationName(nodeId)}`, 'medium');
  }
}
