import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SparklineComponent } from '../../shared/ui/sparkline.component';
import { KpiTileVm } from './kpi.store';

/** One KPI tile: value, delta (colour + arrow + sign), sparkline, target, provenance. */
@Component({
  selector: 'scl-kpi-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SparklineComponent],
  template: `
    @let t = tile();
    <article class="tile card" [class]="t.status" [attr.aria-label]="t.label">
      <header>
        <span class="lbl">{{ t.label }}</span>
        @if (t.estimate) { <span class="chip neutral" title="Estimate — see methodology">est.</span> }
        @if (t.stale) { <span class="chip warn" title="Value is older than expected">stale</span> }
        <details class="info"><summary aria-label="About this metric">ⓘ</summary><p>{{ t.info }}</p></details>
      </header>
      <div class="val">
        <strong>{{ t.value }}</strong>
        @if (t.delta; as d) {
          <span class="delta" [class.good]="d.good === true" [class.bad]="d.good === false">
            {{ d.dir === 'up' ? '▲' : d.dir === 'down' ? '▼' : '■' }} {{ d.text }}
          </span>
        }
      </div>
      <div class="meta">
        <span>{{ t.sub ?? '' }}</span>
        @if (t.target) { <span class="faint">{{ t.target }}</span> }
      </div>
      @if (t.spark.length > 1) { <scl-sparkline class="spark" [values]="t.spark" [ariaLabel]="t.label + ' trend'" /> }
      <span class="state" [attr.aria-label]="'Status ' + t.status">
        {{ t.status === 'ok' ? '✔ on target' : t.status === 'warn' ? '▲ near limit' : t.status === 'breach' ? '✖ off target' : '' }}
      </span>
    </article>
  `,
  styles: [`
    .tile { padding: .7rem .85rem; display: flex; flex-direction: column; gap: .2rem; position: relative; min-width: 0; border-left: 4px solid var(--border); }
    .tile.ok { border-left-color: var(--ok); } .tile.warn { border-left-color: var(--warn); } .tile.breach { border-left-color: var(--danger); }
    header { display: flex; align-items: center; gap: .4rem; }
    .lbl { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); font-weight: 700; flex: 1; }
    .info { position: relative; } .info summary { cursor: pointer; list-style: none; color: var(--text-faint); }
    .info p { position: absolute; right: 0; top: 1.4rem; width: 15rem; z-index: 5; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: .5rem .7rem; font-size: .75rem; margin: 0; box-shadow: var(--shadow); }
    .val { display: flex; align-items: baseline; gap: .6rem; }
    .val strong { font-size: 1.75rem; line-height: 1.1; }
    .delta { font-size: .78rem; font-weight: 700; color: var(--text-dim); }
    .delta.good { color: var(--ok); } .delta.bad { color: var(--danger); }
    .meta { display: flex; justify-content: space-between; font-size: .75rem; color: var(--text-dim); min-height: 1rem; }
    .spark { height: 1.8rem; margin-top: .15rem; }
    .state { font-size: .7rem; color: var(--text-faint); min-height: .9rem; }
  `],
})
export class KpiTileComponent {
  readonly tile = input.required<KpiTileVm>();
}
