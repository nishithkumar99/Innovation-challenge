import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

export interface ChartSeries { name: string; values: number[]; color: string; }
export interface ChartBand { lo: number[]; hi: number[]; color: string; label: string; }
export type ChartType = 'line' | 'area' | 'bar' | 'stack';

/**
 * Small dependency-free SVG chart (line / area / bar / stacked bar) with target line, P90-style band,
 * hover tooltip and a data-table toggle (a11y + export parity, blueprint 3.2).
 * Swap for ECharts behind the same inputs if richer interaction is needed.
 */
@Component({
  selector: 'scl-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="chart card" [attr.aria-label]="title()">
      <header>
        <h3>{{ title() }}</h3>
        <button type="button" class="btn ghost sm" (click)="table.set(!table())" [attr.aria-pressed]="table()">
          {{ table() ? 'Chart' : 'Table' }}
        </button>
      </header>
      @if (table()) {
        <div class="tbl">
          <table>
            <thead><tr><th>Time</th>@for (s of series(); track s.name) { <th>{{ s.name }}</th> }</tr></thead>
            <tbody>
              @for (x of xs(); track $index; let i = $index) {
                @if (i % tableStride() === 0) {
                  <tr><td>{{ x }}</td>@for (s of series(); track s.name) { <td>{{ fmt()(s.values[i]) }}</td> }</tr>
                }
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="plot" [style.height.px]="height()">
          <svg [attr.viewBox]="'0 0 ' + W + ' ' + height()" preserveAspectRatio="none" role="img"
               (pointermove)="hover($event)" (pointerleave)="idx.set(null)">
            @for (t of g().yTicks; track t.v) {
              <line [attr.x1]="L" [attr.x2]="W - R" [attr.y1]="t.y" [attr.y2]="t.y" class="grid" />
              <text [attr.x]="L - 6" [attr.y]="t.y + 3" class="ylab">{{ fmt()(t.v) }}</text>
            }
            @for (t of g().xTicks; track t.i) {
              <text [attr.x]="t.x" [attr.y]="height() - 4" class="xlab" text-anchor="middle">{{ t.label }}</text>
            }
            @if (g().band; as b) { <path [attr.d]="b" class="band" [style.fill]="band()?.color" /> }
            @for (p of g().paths; track p.name) {
              @if (p.area) { <path [attr.d]="p.area" [style.fill]="p.color" class="areafill" /> }
              @if (p.line) { <path [attr.d]="p.line" [style.stroke]="p.color" class="line" /> }
              @for (r of p.rects; track $index) { <rect [attr.x]="r.x" [attr.y]="r.y" [attr.width]="r.w" [attr.height]="r.h" [style.fill]="p.color" /> }
            }
            @if (g().targetY !== null) {
              <line [attr.x1]="L" [attr.x2]="W - R" [attr.y1]="g().targetY" [attr.y2]="g().targetY" class="target" />
              <text [attr.x]="W - R" [attr.y]="g().targetY! - 4" text-anchor="end" class="tlab">{{ target()?.label }}</text>
            }
            @if (idx() !== null) { <line [attr.x1]="g().xAt(idx()!)" [attr.x2]="g().xAt(idx()!)" [attr.y1]="T" [attr.y2]="height() - B" class="guide" /> }
          </svg>
          @if (idx() !== null) {
            <div class="tip" [style.left.%]="(g().xAt(idx()!) / W) * 100">
              <strong>{{ xs()[idx()!] }}</strong>
              @for (s of series(); track s.name) {
                <div><i [style.background]="s.color"></i>{{ s.name }}: {{ fmt()(s.values[idx()!]) }}</div>
              }
            </div>
          }
        </div>
        <footer>
          @for (s of series(); track s.name) { <span class="lg"><i [style.background]="s.color"></i>{{ s.name }}</span> }
          @if (band()) { <span class="lg"><i [style.background]="band()!.color" style="opacity:.4"></i>{{ band()!.label }}</span> }
        </footer>
      }
    </section>
  `,
  styles: [`
    .chart { padding: .75rem .85rem .6rem; display: flex; flex-direction: column; gap: .35rem; min-width: 0; }
    header { display: flex; justify-content: space-between; align-items: center; }
    h3 { margin: 0; font-size: .85rem; font-weight: 600; color: var(--text-dim); }
    .plot { position: relative; }
    svg { width: 100%; height: 100%; display: block; }
    .grid { stroke: var(--border); stroke-width: 1; }
    .ylab, .xlab { fill: var(--text-faint); font-size: 9px; }
    .ylab { text-anchor: end; }
    .line { fill: none; stroke-width: 1.8; vector-effect: non-scaling-stroke; }
    .areafill { opacity: .16; }
    .band { opacity: .14; }
    .target { stroke: var(--warn); stroke-dasharray: 4 3; stroke-width: 1; }
    .tlab { fill: var(--warn); font-size: 9px; }
    .guide { stroke: var(--text-faint); stroke-dasharray: 2 2; }
    .tip { position: absolute; top: 4px; transform: translateX(-50%); background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 6px; padding: .3rem .5rem; font-size: .72rem; pointer-events: none; white-space: nowrap; z-index: 2; }
    .tip i, .lg i { display: inline-block; width: .6rem; height: .6rem; border-radius: 2px; margin-right: .3rem; }
    footer { display: flex; gap: .9rem; flex-wrap: wrap; font-size: .72rem; color: var(--text-dim); }
    .tbl { max-height: 14rem; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .75rem; }
    th, td { text-align: right; padding: .2rem .4rem; border-bottom: 1px solid var(--border); }
    th:first-child, td:first-child { text-align: left; }
  `],
})
export class ChartComponent {
  readonly title = input.required<string>();
  readonly type = input<ChartType>('line');
  readonly series = input.required<ChartSeries[]>();
  readonly xs = input.required<string[]>();
  readonly band = input<ChartBand | null>(null);
  readonly target = input<{ value: number; label: string } | null>(null);
  readonly height = input(190);
  readonly fmt = input<(n: number) => string>((n) => String(Math.round(n * 10) / 10));

  protected readonly W = 600;
  protected readonly L = 42;
  protected readonly R = 10;
  protected readonly T = 8;
  protected readonly B = 18;
  protected readonly table = signal(false);
  protected readonly idx = signal<number | null>(null);
  protected readonly tableStride = computed(() => Math.max(1, Math.ceil(this.xs().length / 40)));

  protected readonly g = computed(() => {
    const { W, L, R, T, B } = this;
    const H = this.height();
    const series = this.series();
    const n = Math.max(0, ...series.map((s) => s.values.length));
    const type = this.type();
    const stacked = type === 'stack';
    const totals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
    let max = stacked ? Math.max(1, ...totals) : Math.max(1, ...series.flatMap((s) => s.values));
    const bandHi = this.band()?.hi ?? [];
    if (bandHi.length) max = Math.max(max, ...bandHi);
    const tgt = this.target();
    if (tgt) max = Math.max(max, tgt.value * 1.05);
    max *= 1.1;
    const plotW = W - L - R;
    const plotH = H - T - B;
    const isBar = type === 'bar' || stacked;
    const xAt = (i: number) => (isBar ? L + ((i + 0.5) / Math.max(1, n)) * plotW : L + (n <= 1 ? 0.5 : i / (n - 1)) * plotW);
    const yAt = (v: number) => T + plotH - (v / max) * plotH;
    const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v ?? 0).toFixed(1)}`).join(' ');

    const base = Array.from({ length: n }, () => 0);
    const paths = series.map((s) => {
      if (isBar) {
        const bw = Math.max(1, (plotW / Math.max(1, n)) * 0.7);
        const rects = s.values.map((v, i) => {
          const y0 = stacked ? base[i] : 0;
          const y1 = y0 + (v ?? 0);
          if (stacked) base[i] = y1;
          return { x: xAt(i) - bw / 2, y: yAt(y1), w: bw, h: Math.max(0, yAt(y0) - yAt(y1)) };
        });
        return { name: s.name, color: s.color, line: '', area: '', rects };
      }
      const line = s.values.length > 1 ? path(s.values) : '';
      const area = type === 'area' && line ? `${line} L${xAt(s.values.length - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z` : '';
      return { name: s.name, color: s.color, line, area, rects: [] as { x: number; y: number; w: number; h: number }[] };
    });

    const b = this.band();
    const band = b && b.hi.length > 1
      ? `${b.hi.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')} ${[...b.lo].reverse().map((v, i) => `L${xAt(b.lo.length - 1 - i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')} Z`
      : null;

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: (max / 1.1) * f, y: yAt((max / 1.1) * f) }));
    const xl = this.xs();
    const step = Math.max(1, Math.floor(n / 5));
    const xTicks = Array.from({ length: n }, (_, i) => i).filter((i) => i % step === 0).map((i) => ({ i, x: xAt(i), label: xl[i] ?? '' }));
    return { paths, band, yTicks, xTicks, targetY: tgt ? yAt(tgt.value) : null, xAt, n };
  });

  protected hover(ev: PointerEvent): void {
    const el = ev.currentTarget as SVGSVGElement;
    const rect = el.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * this.W;
    const { n } = this.g();
    if (!n) return;
    const frac = (x - this.L) / (this.W - this.L - this.R);
    const bar = this.type() === 'bar' || this.type() === 'stack';
    const i = bar ? Math.floor(frac * n) : Math.round(frac * (n - 1));
    this.idx.set(i >= 0 && i < n ? i : null);
  }
}
