import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { DialogService } from './dialog.service';

/** Renders whichever dialog DialogService has open, using a native <dialog> (focus trap, Esc, backdrop for free). */
@Component({
  selector: 'scl-dialog-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg (cancel)="$event.preventDefault(); dialogs.close(null)" (click)="backdrop($event)" aria-labelledby="dlg-title">
      @if (dialogs.active(); as a) {
        <form class="body" (submit)="$event.preventDefault(); submit()">
          <h2 id="dlg-title" [class.danger]="a.cfg.tone === 'danger'">{{ a.cfg.title }}</h2>
          @if (a.cfg.message) { <p class="muted">{{ a.cfg.message }}</p> }
          @for (f of a.cfg.fields ?? []; track f.key) {
            <label class="field">
              {{ f.label }}@if (f.required) { <span aria-hidden="true"> *</span> }
              @switch (f.type) {
                @case ('select') {
                  <select [value]="values()[f.key]" (change)="set(f.key, $any($event.target).value)">
                    @for (o of f.options ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
                  </select>
                }
                @case ('textarea') {
                  <textarea [value]="values()[f.key]" [attr.placeholder]="f.placeholder" (input)="set(f.key, $any($event.target).value)"></textarea>
                }
                @default {
                  <input [type]="f.type" [value]="values()[f.key]" [attr.placeholder]="f.placeholder" autocomplete="off"
                         [attr.inputmode]="f.type === 'number' ? 'numeric' : null" (input)="set(f.key, $any($event.target).value)" />
                }
              }
            </label>
          }
          <footer>
            <button type="button" class="btn ghost" (click)="dialogs.close(null)">Cancel</button>
            <button type="submit" class="btn" [class.danger]="a.cfg.tone === 'danger'" [class.primary]="a.cfg.tone !== 'danger'" [disabled]="!valid()">
              {{ a.cfg.confirmLabel ?? 'Confirm' }}
            </button>
          </footer>
        </form>
      }
    </dialog>
  `,
  styles: [`
    dialog { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 12px; padding: 0; width: min(30rem, 92vw); box-shadow: var(--shadow); }
    dialog::backdrop { background: rgba(2, 6, 10, .65); backdrop-filter: blur(2px); }
    .body { padding: 1.1rem 1.25rem; display: flex; flex-direction: column; gap: .8rem; }
    h2 { font-size: 1.1rem; } h2.danger { color: var(--danger); }
    p { margin: 0; }
    footer { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .3rem; }
  `],
})
export class DialogHostComponent {
  protected readonly dialogs = inject(DialogService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  protected readonly values = signal<Record<string, string>>({});

  constructor() {
    effect(() => {
      const a = this.dialogs.active();
      const el = this.dlg().nativeElement;
      if (a) {
        this.values.set(Object.fromEntries((a.cfg.fields ?? []).map((f) => [f.key, f.value ?? (f.type === 'select' ? f.options?.[0]?.value ?? '' : '')])));
        if (!el.open) el.showModal();
      } else if (el.open) {
        el.close();
      }
    });
  }

  protected set(key: string, value: string): void { this.values.update((v) => ({ ...v, [key]: value })); }

  protected valid(): boolean {
    const a = this.dialogs.active();
    return !!a && (a.cfg.fields ?? []).every((f) => !f.required || (this.values()[f.key] ?? '').trim().length > 0);
  }

  protected submit(): void { if (this.valid()) this.dialogs.close(this.values()); }

  protected backdrop(ev: MouseEvent): void { if (ev.target === this.dlg().nativeElement) this.dialogs.close(null); }
}
