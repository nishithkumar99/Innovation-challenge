import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FleetRestApi } from '../../core/backend/fleet-backend';
import { NotificationService } from '../../core/layout/notification.service';
import { SIM_TIME_SCALE, TaskPriority, TaskSource } from '../../core/models';
import { EMPTY, Observable, Subscription, catchError, concat, defer, interval, mergeMap, of, repeat, take, tap, timer } from 'rxjs';
import { TaskStore } from './task.store';
import { randomRequest, SOURCES } from './task-templates';

type Mode = 'SINGLE' | 'BURST' | 'POISSON';
const HARD_CAP = 200;

interface Preset { label: string; source: TaskSource | 'MIXED'; mode: Mode; n: number; secs: number; rate: number; }
const PRESETS: Preset[] = [
  { label: 'Morning rush', source: 'PHARMACY', mode: 'POISSON', n: 0, secs: 0, rate: 60 },
  { label: 'Shift change', source: 'WARD', mode: 'BURST', n: 14, secs: 40, rate: 0 },
  { label: 'Lab surge', source: 'LAB', mode: 'BURST', n: 12, secs: 30, rate: 0 },
];

/**
 * Operator simulator (blueprint 1.6): generates SIMULATED tasks from a chosen source to exercise dispatching
 * and the AI layer. Client-side pipeline with a hard cap and a visible kill switch.
 */
@Component({
  selector: 'scl-simulator-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="banner sim" role="note">SIMULATION — tasks created here are tagged SIMULATED. Hard cap {{ cap }} per run.</div>
      <div class="page-head"><div><h1>Task simulator</h1><p>Generate load from pharmacy, lab, sterile services and ward stations.</p></div></div>

      <div class="card panel">
        <div class="grid">
          <label class="field">Source
            <select [value]="source()" (change)="source.set($any($event.target).value)">
              <option value="MIXED">Mixed (all sources)</option>
              @for (s of sources; track s.source) { <option [value]="s.source">{{ s.label }}</option> }
            </select>
          </label>
          <label class="field">Priority
            <select [value]="priority()" (change)="priority.set($any($event.target).value)">
              <option value="MIXED">Mixed</option><option value="STAT">STAT</option><option value="URGENT">Urgent</option><option value="ROUTINE">Routine</option>
            </select>
          </label>
        </div>

        <fieldset class="modes">
          <legend class="faint">Mode</legend>
          @for (m of modes; track m.v) {
            <label class="seg" [class.on]="mode() === m.v"><input type="radio" name="mode" [checked]="mode() === m.v" (change)="mode.set(m.v)" /> {{ m.label }}</label>
          }
        </fieldset>

        @switch (mode()) {
          @case ('BURST') {
            <div class="grid">
              <label class="field">Tasks (n)<input type="number" min="1" [max]="cap" [value]="n()" (input)="n.set(+$any($event.target).value)" /></label>
              <label class="field">Spread over (seconds, real time)<input type="number" min="1" [value]="secs()" (input)="secs.set(+$any($event.target).value)" /></label>
            </div>
          }
          @case ('POISSON') {
            <label class="field">Mean arrival rate λ (tasks per simulated hour)
              <input type="number" min="1" max="600" [value]="rate()" (input)="rate.set(+$any($event.target).value)" />
              <small class="faint">≈ one task every {{ meanSeconds() }} s of real time (hospital time runs ×{{ scale }}).</small>
            </label>
          }
        }

        <div class="presets">
          <span class="faint">Scenario presets</span>
          @for (p of presets; track p.label) { <button type="button" class="btn sm" [disabled]="running()" (click)="apply(p)">{{ p.label }}</button> }
        </div>

        <div class="controls">
          @if (!running()) { <button type="button" class="btn primary lg" (click)="start()">▶ Start</button> }
          @else { <button type="button" class="btn danger lg" (click)="stop()">■ Stop (kill switch)</button> }
          <div class="stats" aria-live="polite">
            <div><strong>{{ generated() }}</strong><small>generated</small></div>
            <div><strong>{{ tasks.simulatedOpen() }}</strong><small>simulated tasks active</small></div>
            <div><strong>{{ failed() }}</strong><small>failed</small></div>
          </div>
        </div>
        @if (capped()) { <div class="banner warn">Stopped at the hard cap of {{ cap }} tasks.</div> }
      </div>
    </div>
  `,
  styles: [`
    .panel { padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .8rem; }
    .modes { border: 0; margin: 0; padding: 0; display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
    .modes legend { float: left; width: 100%; font-size: .78rem; font-weight: 600; margin-bottom: .25rem; padding: 0; }
    .seg { border: 1px solid var(--border); border-radius: 8px; padding: .45rem .9rem; cursor: pointer; font-weight: 700; background: var(--surface-2); display: inline-flex; gap: .4rem; align-items: center; }
    .seg.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
    .presets { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
    .controls { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; border-top: 1px solid var(--border); padding-top: 1rem; }
    .stats { display: flex; gap: 1.6rem; } .stats div { display: flex; flex-direction: column; } .stats strong { font-size: 1.5rem; line-height: 1.1; } .stats small { color: var(--text-dim); }
  `],
})
export class SimulatorPageComponent {
  protected readonly tasks = inject(TaskStore);
  private readonly api = inject(FleetRestApi);
  private readonly toast = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly cap = HARD_CAP;
  protected readonly scale = SIM_TIME_SCALE;
  protected readonly sources = SOURCES;
  protected readonly presets = PRESETS;
  protected readonly modes: { v: Mode; label: string }[] = [
    { v: 'SINGLE', label: 'Single' }, { v: 'BURST', label: 'Burst' }, { v: 'POISSON', label: 'Poisson stream' },
  ];

  protected readonly source = signal<TaskSource | 'MIXED'>('MIXED');
  protected readonly priority = signal<TaskPriority | 'MIXED'>('MIXED');
  protected readonly mode = signal<Mode>('BURST');
  protected readonly n = signal(10);
  protected readonly secs = signal(60);
  protected readonly rate = signal(30);
  protected readonly running = signal(false);
  protected readonly generated = signal(0);
  protected readonly failed = signal(0);
  protected readonly capped = signal(false);
  protected readonly meanSeconds = computed(() => Math.max(1, Math.round(3600 / Math.max(1, this.rate()) / SIM_TIME_SCALE)));
  private sub?: Subscription;

  constructor() { this.destroyRef.onDestroy(() => this.sub?.unsubscribe()); }

  protected apply(p: Preset): void {
    this.source.set(p.source); this.mode.set(p.mode);
    if (p.n) this.n.set(p.n);
    if (p.secs) this.secs.set(p.secs);
    if (p.rate) this.rate.set(p.rate);
  }

  protected start(): void {
    this.generated.set(0); this.failed.set(0); this.capped.set(false);
    this.running.set(true);
    const m = this.mode();
    let source$: Observable<unknown>;
    if (m === 'SINGLE') source$ = of(0);
    else if (m === 'BURST') {
      const n = Math.min(HARD_CAP, Math.max(1, this.n()));
      source$ = concat(of(0), interval((Math.max(1, this.secs()) * 1000) / n).pipe(take(n - 1)));
    } else {
      // Poisson arrivals: exponential inter-arrival times
      source$ = defer(() => timer(-Math.log(1 - Math.random()) * this.meanSeconds() * 1000)).pipe(repeat());
    }
    this.sub = source$.pipe(
      tap(() => {
        if (this.generated() + this.failed() >= HARD_CAP) { this.capped.set(true); this.stop(); }
      }),
      mergeMap(() => {
        if (!this.running()) return EMPTY;
        const req = randomRequest(this.source(), this.priority());
        this.generated.update((x) => x + 1);
        return this.api.createTask(req, crypto.randomUUID()).pipe(
          catchError(() => { this.failed.update((x) => x + 1); return EMPTY; }),
        );
      }),
    ).subscribe({ complete: () => this.running.set(false) });
  }

  protected stop(): void {
    this.sub?.unsubscribe();
    this.running.set(false);
    this.toast.push('info', 'Simulator stopped.');
  }
}
