import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'scl-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="'0 0 ' + width() + ' ' + height()" preserveAspectRatio="none" role="img" [attr.aria-label]="ariaLabel()">
      @if (path(); as p) {
        <path [attr.d]="p.area" class="area" />
        <path [attr.d]="p.line" class="line" />
        <circle [attr.cx]="p.lastX" [attr.cy]="p.lastY" r="2.2" class="dot" />
      }
    </svg>
  `,
  styles: [`
    :host { display: block; }
    svg { width: 100%; height: 100%; display: block; overflow: visible; }
    .line { fill: none; stroke: var(--accent); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
    .area { fill: var(--accent); opacity: .12; }
    .dot { fill: var(--accent); }
  `],
})
export class SparklineComponent {
  readonly values = input<number[]>([]);
  readonly width = input(120);
  readonly height = input(28);
  readonly ariaLabel = input('Trend over the last hour');

  protected readonly path = computed(() => {
    const v = this.values();
    if (v.length < 2) return null;
    const w = this.width(), h = this.height(), pad = 3;
    const min = Math.min(...v), max = Math.max(...v);
    const span = max - min || 1;
    const pts = v.map((y, i) => [(i / (v.length - 1)) * w, h - pad - ((y - min) / span) * (h - pad * 2)] as const);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return { line, area: `${line} L${w},${h} L0,${h} Z`, lastX: pts.at(-1)![0], lastY: pts.at(-1)![1] };
  });
}
