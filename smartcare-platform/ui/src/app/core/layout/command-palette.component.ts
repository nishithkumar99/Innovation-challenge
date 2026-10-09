import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService, PERSONAS } from '../auth/auth.service';
import { IS_MOCK_BACKEND } from '../backend/fleet-backend';
import { MockControls } from '../backend/mock/mock-backend';
import { Permission } from '../models';
import { stationName } from '../map-data';
import { FleetStore } from '../../domain/fleet/fleet.store';
import { UiStore } from '../../domain/fleet/ui.store';
import { TaskStore } from '../../domain/tasks/task.store';
import { NotificationService } from './notification.service';
import { SoundService } from './sound.service';
import { TourService } from './tour.service';

interface Cmd { id: string; group: string; icon: string; label: string; hint?: string; keywords?: string; run: () => void; }

/** Ctrl/⌘+K: go to any page, robot or task, switch role, run a demo scenario. Everything is filtered as you type. */
@Component({
  selector: 'scl-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.paletteOpen()) {
      <div class="backdrop" (click)="close()"></div>
      <div class="pal card" role="dialog" aria-modal="true" aria-label="Command palette">
        <input #q id="palette-input" type="text" autocomplete="off" spellcheck="false" placeholder="Type to search pages, robots, tasks and actions…"
               role="combobox" aria-expanded="true" aria-controls="palette-list" [attr.aria-activedescendant]="'pal-' + active()"
               [value]="query()" (input)="query.set($any($event.target).value); active.set(0)" (keydown)="onKey($event)" />
        <ul id="palette-list" role="listbox">
          @for (c of results(); track c.id; let i = $index) {
            @if (i === 0 || results()[i - 1].group !== c.group) { <li class="grp" role="presentation">{{ c.group }}</li> }
            <li role="option" [id]="'pal-' + i" [class.on]="i === active()" [attr.aria-selected]="i === active()" (mousemove)="active.set(i)" (click)="exec(c)">
              <span class="ic" aria-hidden="true">{{ c.icon }}</span><span class="lbl">{{ c.label }}</span>
              @if (c.hint) { <span class="hint">{{ c.hint }}</span> }
            </li>
          } @empty { <li class="none">Nothing matches “{{ query() }}”.</li> }
        </ul>
        <div class="foot"><span><kbd class="kbd">↑</kbd> <kbd class="kbd">↓</kbd> move</span><span><kbd class="kbd">Enter</kbd> run</span><span><kbd class="kbd">Esc</kbd> close</span></div>
      </div>
    }
  `,
  styles: [`
    .backdrop { position: fixed; inset: 0; background: rgba(3, 8, 14, .55); z-index: 80; }
    .pal { position: fixed; z-index: 81; top: 12vh; left: 50%; transform: translateX(-50%); width: min(38rem, calc(100vw - 2rem)); box-shadow: var(--shadow); overflow: hidden; }
    input { width: 100%; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; padding: .9rem 1rem; font-size: 1rem; color: var(--text); outline: none; }
    ul { list-style: none; margin: 0; padding: .3rem; max-height: min(24rem, 52vh); overflow: auto; }
    li { display: flex; align-items: center; gap: .6rem; padding: .5rem .7rem; border-radius: 8px; cursor: pointer; }
    li.on { background: color-mix(in srgb, var(--accent) 20%, transparent); }
    li.grp { cursor: default; font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-faint); font-weight: 700; padding: .5rem .7rem .2rem; }
    li.none { color: var(--text-dim); cursor: default; }
    .ic { width: 1.3rem; text-align: center; } .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { color: var(--text-faint); font-size: .75rem; white-space: nowrap; }
    .foot { display: flex; gap: 1rem; padding: .45rem .9rem; border-top: 1px solid var(--border); font-size: .72rem; color: var(--text-dim); }
  `],
})
export class CommandPaletteComponent {
  protected readonly ui = inject(UiStore);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fleet = inject(FleetStore);
  private readonly tasks = inject(TaskStore);
  private readonly tour = inject(TourService);
  private readonly sound = inject(SoundService);
  private readonly toast = inject(NotificationService);
  private readonly mock = inject(MockControls);
  private readonly isMock = inject(IS_MOCK_BACKEND);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('q');

  protected readonly query = signal('');
  protected readonly active = signal(0);

  private readonly pages: { label: string; icon: string; route: string; perm: Permission; staff?: boolean; kw?: string }[] = [
    { label: 'Control center', icon: '◉', route: '/ops', perm: 'fleet:view:full', kw: 'map live fleet' },
    { label: 'Tasks', icon: '☰', route: '/tasks', perm: 'task:read:all', kw: 'queue transport' },
    { label: 'Create a task', icon: '＋', route: '/tasks/new', perm: 'task:read:all', kw: 'new request' },
    { label: 'AI Control', icon: '✦', route: '/ai', perm: 'fleet:view:full', kw: 'ai dispatch energy battery traffic deadlock anomaly priority charging' },
    { label: 'KPIs', icon: '▤', route: '/kpi', perm: 'kpi:view:basic', kw: 'statistics performance' },
    { label: 'Simulator', icon: '⚙', route: '/simulator', perm: 'simulation:run', kw: 'load test burst' },
    { label: 'Audit log', icon: '✎', route: '/audit', perm: 'audit:view', kw: 'history commands' },
    { label: 'New request', icon: '＋', route: '/request/new', perm: 'task:create', staff: true, kw: 'order delivery' },
    { label: 'My requests', icon: '☰', route: '/request/mine', perm: 'task:read:own', staff: true, kw: 'status' },
    { label: 'Department status', icon: '⌂', route: '/request/status', perm: 'fleet:view', staff: true, kw: 'busy delays' },
  ];

  private readonly all = computed<Cmd[]>(() => {
    const out: Cmd[] = [];
    const ops = this.auth.isOps();
    for (const p of this.pages) {
      if (!this.auth.can(p.perm) || (p.staff && ops)) continue;
      out.push({ id: 'p' + p.route, group: 'Go to', icon: p.icon, label: p.label, keywords: p.kw, run: () => void this.router.navigateByUrl(p.route) });
    }
    out.push({ id: 'a-theme', group: 'Actions', icon: this.ui.theme() === 'dark' ? '☀' : '☾', label: 'Switch light / dark theme', keywords: 'appearance mode', run: () => this.ui.toggleTheme() });
    out.push({ id: 'a-text', group: 'Actions', icon: 'Aa', label: 'Change text size', hint: 'small · medium · large', keywords: 'font bigger smaller accessibility', run: () => this.ui.textSize.update((t) => (t === 'm' ? 'l' : t === 'l' ? 's' : 'm')) });
    out.push({ id: 'a-sound', group: 'Actions', icon: '🔔', label: this.sound.enabled() ? 'Turn alert sound off' : 'Turn alert sound on', keywords: 'beep audio critical', run: () => this.sound.toggle() });
    out.push({ id: 'a-tour', group: 'Actions', icon: '❓', label: 'Take the guided tour', keywords: 'help onboarding walkthrough', run: () => void this.tour.start() });
    out.push({ id: 'a-help', group: 'Actions', icon: '⌨', label: 'Keyboard shortcuts and help', hint: '?', keywords: 'keys', run: () => this.ui.helpOpen.set(true) });
    for (const p of PERSONAS) {
      if (p.id === this.auth.user().id) continue;
      out.push({ id: 'u-' + p.id, group: 'Switch role (demo)', icon: '👤', label: p.name, hint: p.roleLabel, keywords: 'user persona login', run: () => { this.auth.switchPersona(p.id); void this.router.navigateByUrl(this.auth.landingRoute()); } });
    }
    if (ops) {
      for (const r of this.fleet.robotViews()) {
        out.push({ id: 'r-' + r.id, group: 'Robots', icon: '🤖', label: r.name, hint: `${Math.round(r.battery)}% battery`, keywords: r.id + ' robot amr',
          run: () => { this.ui.select({ kind: 'robot', id: r.id }); void this.router.navigateByUrl('/ops'); } });
      }
      for (const t of this.tasks.open().slice(0, 25)) {
        out.push({ id: 't-' + t.id, group: 'Open tasks', icon: '📦', label: `${t.id} · ${stationName(t.from)} → ${stationName(t.to)}`, hint: t.priority, keywords: t.item,
          run: () => { this.ui.select({ kind: 'task', id: t.id }); void this.router.navigateByUrl('/ops'); } });
      }
      if (this.isMock) {
        const sc = (id: 'rush' | 'corridor' | 'fault' | 'calm', label: string, kw: string) => out.push({
          id: 's-' + id, group: 'Demo scenarios', icon: '🧪', label, keywords: kw,
          run: () => { this.toast.push('info', this.mock.scenario(id)); void this.router.navigateByUrl('/ops'); },
        });
        sc('rush', 'Morning rush (14 new requests)', 'busy load burst');
        sc('corridor', 'Block the corridor to Ward A', 'congestion route');
        sc('fault', 'A robot reports a fault', 'error breakdown estop');
        sc('calm', 'Back to normal', 'reset clear');
      }
    }
    return out;
  });

  protected readonly results = computed(() => {
    const terms = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const list = this.all();
    if (!terms.length) return list.filter((c) => ['Go to', 'Actions'].includes(c.group)).slice(0, 14);
    return list.filter((c) => { const hay = `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''} ${c.group}`.toLowerCase(); return terms.every((t) => hay.includes(t)); }).slice(0, 20);
  });

  constructor() {
    effect(() => {
      if (this.ui.paletteOpen()) { this.query.set(''); this.active.set(0); setTimeout(() => this.input()?.nativeElement.focus(), 0); }
    });
  }

  protected close(): void { this.ui.paletteOpen.set(false); }
  protected exec(c: Cmd): void { this.close(); c.run(); }

  protected onKey(ev: KeyboardEvent): void {
    const n = this.results().length;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); this.active.set(n ? (this.active() + 1) % n : 0); this.scroll(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); this.active.set(n ? (this.active() - 1 + n) % n : 0); this.scroll(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); const c = this.results()[this.active()]; if (c) this.exec(c); }
    else if (ev.key === 'Escape') { ev.preventDefault(); this.close(); }
  }

  private scroll(): void { setTimeout(() => document.getElementById('pal-' + this.active())?.scrollIntoView({ block: 'nearest' }), 0); }
}
