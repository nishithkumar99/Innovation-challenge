import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, effect, inject, signal } from '@angular/core';
import { TourService } from './tour.service';

interface Box { top: number; left: number; width: number; height: number; }

/** Spotlight tour: dims the page, outlines one element and explains it. Keyboard: → next, ← back, Esc leaves. */
@Component({
  selector: 'scl-tour',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tour.active() && tour.step(); as s) {
      <div class="veil" (click)="tour.finish()"></div>
      @if (box(); as b) { <div class="spot" [style.top.px]="b.top - 6" [style.left.px]="b.left - 6" [style.width.px]="b.width + 12" [style.height.px]="b.height + 12"></div> }
      <div class="card tip" role="dialog" aria-modal="true" aria-labelledby="tour-title" [style.top.px]="pos().top" [style.left.px]="pos().left" [class.center]="!box()">
        <div class="meta">Step {{ tour.index() + 1 }} of {{ tour.steps().length }}</div>
        <h2 id="tour-title">{{ s.title }}</h2>
        <p>{{ s.body }}</p>
        <div class="dots" aria-hidden="true">
          @for (st of tour.steps(); track $index) { <i [class.on]="$index === tour.index()"></i> }
        </div>
        <div class="actions">
          <button type="button" class="btn ghost sm" (click)="tour.finish()">Skip tour</button>
          <span class="grow"></span>
          @if (tour.index() > 0) { <button type="button" class="btn sm" (click)="tour.prev()">Back</button> }
          <button type="button" class="btn primary sm" #nextBtn (click)="tour.next()">{{ tour.isLast() ? 'Done' : 'Next' }}</button>
        </div>
      </div>
    }
  `,
  styles: [`
    .veil { position: fixed; inset: 0; z-index: 90; }
    .spot { position: fixed; z-index: 91; border-radius: 10px; pointer-events: none; box-shadow: 0 0 0 9999px rgba(3, 8, 14, .66); outline: 2px solid var(--accent); transition: all .25s ease; }
    .tip { position: fixed; z-index: 92; width: min(21rem, calc(100vw - 2rem)); padding: 1rem 1.1rem; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: .45rem; }
    .tip.center { transform: translate(-50%, -50%); }
    .veil:has(+ .tip.center) { background: rgba(3, 8, 14, .66); }
    h2 { margin: 0; font-size: 1.05rem; } p { margin: 0; color: var(--text-dim); line-height: 1.5; }
    .meta { font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; color: var(--text-faint); font-weight: 700; }
    .dots { display: flex; gap: .3rem; margin-top: .2rem; }
    .dots i { width: .45rem; height: .45rem; border-radius: 50%; background: var(--border); } .dots i.on { background: var(--accent); }
    .actions { display: flex; gap: .4rem; align-items: center; margin-top: .3rem; }
  `],
})
export class TourComponent implements OnDestroy {
  protected readonly tour = inject(TourService);
  protected readonly box = signal<Box | null>(null);
  protected readonly pos = signal({ top: 0, left: 0 });
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      if (this.tour.active()) { this.tour.index(); this.measure(); this.timer ??= setInterval(() => this.measure(), 400); }
      else if (this.timer) { clearInterval(this.timer); this.timer = null; this.box.set(null); }
    });
  }

  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  @HostListener('window:resize') protected onResize(): void { if (this.tour.active()) this.measure(); }

  @HostListener('document:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent): void {
    if (!this.tour.active()) return;
    if (ev.key === 'Escape') { ev.preventDefault(); this.tour.finish(); }
    else if (ev.key === 'ArrowRight' || ev.key === 'Enter') { ev.preventDefault(); this.tour.next(); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); this.tour.prev(); }
  }

  private measure(): void {
    const step = this.tour.step();
    const el = step?.target ? document.querySelector<HTMLElement>(step.target) : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!el || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') {
      this.box.set(null);
      this.pos.set({ top: vh / 2, left: vw / 2 });
      return;
    }
    const r = el.getBoundingClientRect();
    this.box.set({ top: r.top, left: r.left, width: r.width, height: r.height });
    const w = Math.min(336, vw - 32), h = 220;
    const below = r.bottom + 14 + h < vh;
    const top = below ? r.bottom + 14 : Math.max(12, r.top - h - 14);
    const left = Math.min(Math.max(16, r.left), vw - w - 16);
    // A very tall target (the map) leaves no room above or below: float the card inside it instead.
    this.pos.set(r.height > vh * 0.5 ? { top: r.top + 56, left: Math.min(Math.max(16, r.left + 24), vw - w - 16) } : { top, left });
  }
}
