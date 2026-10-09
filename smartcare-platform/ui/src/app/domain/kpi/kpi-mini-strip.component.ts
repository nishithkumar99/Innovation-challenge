import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { KpiStore } from './kpi.store';
import { KpiTileComponent } from './kpi-tile.component';

@Component({
  selector: 'scl-kpi-mini-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiTileComponent],
  template: `
    <div class="strip">
      @for (t of store.tiles(); track t.id) { <scl-kpi-tile [tile]="t" /> }
      @empty { <div class="empty">Loading KPIs…</div> }
    </div>
  `,
  styles: [`.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .6rem; }`],
})
export class KpiMiniStripComponent {
  protected readonly store = inject(KpiStore);
}
