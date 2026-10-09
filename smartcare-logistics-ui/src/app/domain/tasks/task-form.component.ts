import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, of, startWith, switchMap } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { FleetRestApi } from '../../core/backend/fleet-backend';
import { NotificationService } from '../../core/layout/notification.service';
import { stationName } from '../../core/map-data';
import { TaskPriority, TaskRequest, TaskSource, ValidationResult } from '../../core/models';
import { QuickTemplate, TASK_TEMPLATES } from './task-templates';

type Ctl = FormControl<string | number | boolean>;

/**
 * One schema-driven form for every source. Typed reactive form; async server-side pre-check returns
 * warnings (never blocks on its own). The same component serves staff requests and the simulator's manual mode.
 */
@Component({
  selector: 'scl-task-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    @if (created(); as id) {
      <div class="done card" role="status">
        <div class="tick">✔</div>
        <h3>Request {{ id }} created</h3>
        <p class="muted">A robot will be assigned shortly. You can follow progress live.</p>
        <div class="wrap-gap">
          @if (!auth.isOps()) { <a class="btn primary" [routerLink]="['/request/track', id]">Track delivery</a> }
          <button type="button" class="btn" (click)="created.set(null)">Create another</button>
        </div>
      </div>
    } @else {
      <form [formGroup]="form()" (ngSubmit)="submit()" class="form" [class.compact]="compact()">
        @if (tpl().quick.length) {
          <div class="quick" role="group" aria-label="Quick templates">
            @for (q of tpl().quick; track q.label) { <button type="button" class="btn sm" (click)="applyQuick(q)">⚡ {{ q.label }}</button> }
          </div>
        }
        <div class="grid2">
          <label class="field">Pickup
            <select formControlName="from">@for (s of tpl().fromOptions; track s) { <option [value]="s">{{ name(s) }}</option> }</select>
          </label>
          <label class="field">Destination
            <select formControlName="to">@for (s of tpl().toOptions; track s) { <option [value]="s">{{ name(s) }}</option> }</select>
          </label>
        </div>

        <fieldset class="prio" aria-label="Priority">
          <legend class="faint">Priority</legend>
          @for (p of priorities; track p.v) {
            <label class="seg" [class.on]="form().controls['priority'].value === p.v" [class]="p.cls">
              <input type="radio" formControlName="priority" [value]="p.v" /> {{ p.label }}<small>{{ p.sla }}</small>
            </label>
          }
        </fieldset>

        <div class="grid2">
          @for (f of tpl().fields; track f.key) {
            <label class="field" [class.check]="f.type === 'checkbox'">
              {{ f.label }}
              @switch (f.type) {
                @case ('select') { <select [formControlName]="f.key">@for (o of f.options ?? []; track o) { <option [value]="o">{{ o }}</option> }</select> }
                @case ('number') { <input type="number" min="1" [formControlName]="f.key" /> }
                @case ('checkbox') { <input type="checkbox" [formControlName]="f.key" /> }
                @default { <input type="text" [formControlName]="f.key" maxlength="120" /> }
              }
            </label>
          }
        </div>

        @for (e of validation()?.errors ?? []; track e) { <div class="field-error" role="alert">✖ {{ e }}</div> }
        @for (w of validation()?.warnings ?? []; track w) { <div class="banner warn">▲ {{ w }}</div> }
        @if (origin() === 'SIMULATED') { <div class="banner sim">SIMULATION — tagged as SIMULATED</div> }

        <button class="btn primary lg" type="submit" [disabled]="submitting() || form().invalid || (validation()?.errors?.length ?? 0) > 0">
          {{ submitting() ? 'Sending…' : 'Send request' }}
        </button>
      </form>
    }
  `,
  styles: [`
    .form { display: flex; flex-direction: column; gap: .8rem; }
    .quick { display: flex; flex-wrap: wrap; gap: .4rem; }
    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .7rem; }
    .prio { border: 0; padding: 0; margin: 0; display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
    .prio legend { font-size: .78rem; font-weight: 600; margin-bottom: .25rem; padding: 0; float: left; width: 100%; }
    .seg { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; padding: .4rem .8rem; cursor: pointer; font-weight: 700; min-width: 6.5rem; background: var(--surface-2); }
    .seg input { position: absolute; opacity: 0; pointer-events: none; }
    .seg small { font-weight: 500; color: var(--text-dim); font-size: .7rem; }
    .seg.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
    .seg.stat.on { border-color: var(--crit); box-shadow: inset 0 0 0 1px var(--crit); background: color-mix(in srgb, var(--crit) 14%, var(--surface-2)); }
    .seg:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
    .field.check { flex-direction: row; align-items: center; gap: .6rem; }
    .done { padding: 1.5rem; text-align: center; display: flex; flex-direction: column; gap: .5rem; align-items: center; }
    .tick { width: 3rem; height: 3rem; border-radius: 50%; background: var(--ok); color: #fff; display: grid; place-items: center; font-size: 1.5rem; }
    .done h3 { font-size: 1.15rem; } .done p { margin: 0; }
  `],
})
export class TaskFormComponent {
  readonly source = input.required<TaskSource>();
  readonly compact = input(false);
  readonly origin = input<'REAL' | 'SIMULATED'>('REAL');
  /** Preferred pickup / destination (e.g. the staff member's own department) when the template allows it. */
  readonly defaultFrom = input<string | null>(null);
  readonly defaultTo = input<string | null>(null);
  readonly defaultPriority = input<string | null>(null);
  readonly created = signal<string | null>(null);

  protected readonly auth = inject(AuthService);
  private readonly api = inject(FleetRestApi);
  private readonly toast = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly tpl = computed(() => TASK_TEMPLATES[this.source()]);
  protected readonly form = signal<FormGroup<Record<string, Ctl>>>(new FormGroup({}));
  protected readonly validation = signal<ValidationResult | null>(null);
  protected readonly submitting = signal(false);
  protected readonly priorities = [
    { v: 'STAT', label: 'STAT', sla: 'within 10 min', cls: 'stat' },
    { v: 'URGENT', label: 'Urgent', sla: 'within 20 min', cls: 'urgent' },
    { v: 'ROUTINE', label: 'Routine', sla: 'within 45 min', cls: 'routine' },
  ];
  private idemKey: string | null = null;
  private readonly check$ = new Subject<TaskRequest>();

  constructor() {
    // Rebuild the form whenever the source changes (schema-driven) and feed every change into the pre-check stream.
    effect((onCleanup) => {
      const t = this.tpl();
      const df = this.defaultFrom();
      const dt = this.defaultTo();
      const dp = this.defaultPriority();
      const controls: Record<string, Ctl> = {
        from: new FormControl(df && t.fromOptions.includes(df) ? df : t.fromOptions[0], { nonNullable: true, validators: Validators.required }),
        to: new FormControl(dt && t.toOptions.includes(dt) ? dt : t.toOptions[0], { nonNullable: true, validators: Validators.required }),
        priority: new FormControl(dp && ['STAT', 'URGENT', 'ROUTINE'].includes(dp) ? dp : 'ROUTINE', { nonNullable: true }),
      };
      for (const f of t.fields) controls[f.key] = new FormControl(f.default, { nonNullable: true });
      const fg = new FormGroup(controls);
      this.form.set(fg);
      this.validation.set(null);
      this.created.set(null);
      const sub = fg.valueChanges.pipe(startWith(null)).subscribe(() => this.check$.next(this.build()));
      onCleanup(() => sub.unsubscribe());
    });

    // Async pre-check (debounced). The server answers errors + warnings; the UI only renders them.
    this.check$.pipe(
      debounceTime(300),
      switchMap((req) => this.api.validateTask(req).pipe(catchError(() => of(null)))),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((v) => this.validation.set(v));
  }

  protected name(id: string) { return stationName(id); }

  protected applyQuick(q: QuickTemplate): void {
    const c = this.form().controls;
    c['from'].setValue(q.from);
    c['to'].setValue(q.to);
    c['priority'].setValue(q.priority);
    for (const [k, v] of Object.entries(q.values ?? {})) c[k]?.setValue(v);
  }

  private build(): TaskRequest {
    const v = this.form().getRawValue();
    const t = this.tpl();
    const item = String(v[t.fields.find((f) => f.isItem)?.key ?? 'item'] ?? 'Item');
    const notes = t.fields.filter((f) => !f.isItem && v[f.key] !== '' && v[f.key] !== false)
      .map((f) => `${f.label}: ${v[f.key] === true ? 'yes' : v[f.key]}`).join(' · ');
    return {
      source: t.source, from: String(v['from']), to: String(v['to']), priority: v['priority'] as TaskPriority,
      item, notes: notes || undefined, origin: this.origin(),
    };
  }

  protected submit(): void {
    if (this.submitting() || this.form().invalid) return;
    this.submitting.set(true);
    this.idemKey ??= crypto.randomUUID(); // retry-safe: same key until the server confirmed
    this.api.createTask(this.build(), this.idemKey).subscribe({
      next: ({ taskId }) => {
        this.idemKey = null;
        this.submitting.set(false);
        this.created.set(taskId);
        this.toast.push('success', `Request ${taskId} created`);
      },
      error: () => { this.submitting.set(false); this.toast.push('error', 'Could not send the request — please try again.'); },
    });
  }
}

