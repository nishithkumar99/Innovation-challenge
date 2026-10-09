import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Horizontal progress tracker (e.g. Requested → Robot assigned → On the way → Delivered). */
@Component({
  selector: 'scl-progress-steps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="track" [attr.aria-label]="'Progress: step ' + (current() + 1) + ' of ' + steps().length + ', ' + steps()[current()]">
      @for (s of steps(); track s; let i = $index) {
        <li [class.done]="i < current() || (i === current() && finished())" [class.now]="i === current() && !finished()" [attr.aria-current]="i === current() ? 'step' : null">
          <span class="dot">{{ i < current() || (i === current() && finished()) ? '✓' : '' }}</span>
          <span class="lbl">{{ s }}</span>
        </li>
      }
    </ol>
  `,
  styles: [`
    .track { list-style: none; margin: .3rem 0; padding: 0; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; }
    li { position: relative; display: flex; flex-direction: column; align-items: center; gap: .3rem; text-align: center; font-size: .78rem; color: var(--text-faint); }
    li::before { content: ''; position: absolute; top: .6rem; right: 50%; width: 100%; height: 3px; background: var(--border); z-index: 0; }
    li:first-child::before { display: none; }
    li.done::before, li.now::before { background: var(--ok); }
    .dot { position: relative; z-index: 1; width: 1.3rem; height: 1.3rem; border-radius: 50%; border: 2px solid var(--border); background: var(--surface); display: grid; place-items: center; font-size: .72rem; font-weight: 800; color: #fff; }
    li.done .dot { background: var(--ok); border-color: var(--ok); }
    li.now .dot { border-color: var(--ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 25%, transparent); animation: pulse 1.6s ease-in-out infinite; }
    li.done, li.now { color: var(--text); } li.now { font-weight: 700; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--ok) 8%, transparent); } }
  `],
})
export class ProgressStepsComponent {
  readonly steps = input.required<string[]>();
  readonly current = input.required<number>();
  /** All steps complete (delivered). */
  readonly finished = input(false);
}
