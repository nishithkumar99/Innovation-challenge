import { ChangeDetectionStrategy, Component, OnDestroy, computed, input, output, signal } from '@angular/core';

/** Press-and-hold confirmation for critical actions (e.g. emergency stop). Keyboard: hold Space/Enter. */
@Component({
  selector: 'scl-hold-to-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="btn danger hold"
      [disabled]="disabled()"
      [attr.title]="disabled() ? disabledReason() : 'Press and hold to confirm'"
      [attr.aria-label]="label() + ' — press and hold to confirm'"
      (pointerdown)="start($event)"
      (pointerup)="cancel()"
      (pointerleave)="cancel()"
      (pointercancel)="cancel()"
      (keydown.space)="start($event)"
      (keydown.enter)="start($event)"
      (keyup.space)="cancel()"
      (keyup.enter)="cancel()"
      (blur)="cancel()"
    >
      <span class="fill" [style.width.%]="progress() * 100"></span>
      <span class="txt">{{ holding() ? 'Keep holding…' : label() }}</span>
    </button>
  `,
  styles: [`
    .hold { position: relative; overflow: hidden; min-width: 9rem; }
    .fill { position: absolute; inset: 0 auto 0 0; background: rgba(255,255,255,.28); pointer-events: none; }
    .txt { position: relative; }
  `],
})
export class HoldToConfirmComponent implements OnDestroy {
  readonly label = input('Hold to confirm');
  readonly holdMs = input(1500);
  readonly disabled = input(false);
  readonly disabledReason = input('');
  readonly confirmed = output<void>();

  protected readonly progress = signal(0);
  protected readonly holding = computed(() => this.progress() > 0);
  private raf = 0;
  private startedAt = 0;

  protected start(ev: Event): void {
    ev.preventDefault();
    if (this.disabled() || this.startedAt) return;
    this.startedAt = performance.now();
    const loop = () => {
      const p = Math.min(1, (performance.now() - this.startedAt) / this.holdMs());
      this.progress.set(p);
      if (p >= 1) { this.reset(); this.confirmed.emit(); return; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  protected cancel(): void { this.reset(); }
  private reset(): void { cancelAnimationFrame(this.raf); this.startedAt = 0; this.progress.set(0); }
  ngOnDestroy(): void { cancelAnimationFrame(this.raf); }
}
