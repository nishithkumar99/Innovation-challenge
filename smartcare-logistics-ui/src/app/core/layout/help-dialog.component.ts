import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { UiStore } from '../../domain/fleet/ui.store';
import { SoundService } from './sound.service';
import { TourService } from './tour.service';

/** Help center: shortcuts, display settings, replay the tour. Opened with “?” or from the header. */
@Component({
  selector: 'scl-help-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.helpOpen()) {
      <div class="backdrop" (click)="close()"></div>
      <section class="card box" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header>
          <h2 id="help-title">Help and settings</h2>
          <button type="button" class="btn ghost sm" (click)="close()" aria-label="Close help">✕</button>
        </header>
        <div class="cols">
          <div>
            <h3 class="panel-title">Keyboard shortcuts</h3>
            <dl>
              <div><dt><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">K</kbd></dt><dd>Search pages, robots and tasks</dd></div>
              <div><dt><kbd class="kbd">?</kbd></dt><dd>Open this help</dd></div>
              @if (auth.isOps()) {
                <div><dt><kbd class="kbd">1</kbd> <kbd class="kbd">2</kbd> <kbd class="kbd">3</kbd></dt><dd>Task queue, fleet, KPIs</dd></div>
                <div><dt><kbd class="kbd">F</kbd></dt><dd>Follow the selected robot</dd></div>
                <div><dt><kbd class="kbd">N</kbd></dt><dd>Create a new task</dd></div>
                <div><dt><kbd class="kbd">Esc</kbd></dt><dd>Clear selection or cancel</dd></div>
                <div><dt>Scroll · drag</dt><dd>Zoom and pan the map</dd></div>
              }
            </dl>
          </div>
          <div>
            <h3 class="panel-title">Display</h3>
            <div class="row">
              <span>Text size</span>
              <div class="seg" role="radiogroup" aria-label="Text size">
                @for (o of sizes; track o.v) { <button type="button" role="radio" class="btn sm" [class.primary]="ui.textSize() === o.v" [attr.aria-checked]="ui.textSize() === o.v" (click)="ui.textSize.set(o.v)">{{ o.label }}</button> }
              </div>
            </div>
            <div class="row">
              <span>Theme</span>
              <button type="button" class="btn sm" (click)="ui.toggleTheme()">{{ ui.theme() === 'dark' ? 'Dark · switch to light' : 'Light · switch to dark' }}</button>
            </div>
            <div class="row">
              <span>Sound for critical alerts</span>
              <button type="button" class="btn sm" [class.primary]="sound.enabled()" role="switch" [attr.aria-checked]="sound.enabled()" (click)="sound.toggle()">{{ sound.enabled() ? 'On' : 'Off' }}</button>
            </div>
            <h3 class="panel-title spaced">New here?</h3>
            <button type="button" class="btn primary" (click)="tourNow()">Take the guided tour</button>
          </div>
        </div>
      </section>
    }
  `,
  styles: [`
    .backdrop { position: fixed; inset: 0; background: rgba(3, 8, 14, .55); z-index: 80; }
    .box { position: fixed; z-index: 81; top: 10vh; left: 50%; transform: translateX(-50%); width: min(40rem, calc(100vw - 2rem)); max-height: 80vh; overflow: auto; padding: 1rem 1.25rem 1.25rem; box-shadow: var(--shadow); }
    header { display: flex; justify-content: space-between; align-items: center; } h2 { margin: 0; font-size: 1.15rem; }
    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1.4rem; margin-top: .6rem; }
    dl { margin: .5rem 0 0; display: flex; flex-direction: column; gap: .5rem; } dl div { display: grid; grid-template-columns: 7.5rem 1fr; gap: .5rem; align-items: center; }
    dt { white-space: nowrap; } dd { margin: 0; color: var(--text-dim); }
    .row { display: flex; justify-content: space-between; align-items: center; gap: .6rem; margin-top: .6rem; }
    .seg { display: flex; gap: .2rem; } .spaced { margin: 1.2rem 0 .5rem; } h3 { margin: 0; }
  `],
})
export class HelpDialogComponent {
  protected readonly ui = inject(UiStore);
  protected readonly auth = inject(AuthService);
  protected readonly sound = inject(SoundService);
  private readonly tour = inject(TourService);
  protected readonly sizes = [{ v: 's', label: 'Small' }, { v: 'm', label: 'Medium' }, { v: 'l', label: 'Large' }] as const;

  protected close(): void { this.ui.helpOpen.set(false); }
  protected tourNow(): void { this.close(); void this.tour.start(); }

  @HostListener('document:keydown.escape') protected onEsc(): void { if (this.ui.helpOpen()) this.close(); }
}
