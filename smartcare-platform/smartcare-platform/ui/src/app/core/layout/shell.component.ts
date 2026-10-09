import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService, PERSONAS } from '../auth/auth.service';
import { HasPermissionDirective } from '../auth/permission.directive';
import { IS_MOCK_BACKEND } from '../backend/fleet-backend';
import { MockControls } from '../backend/mock/mock-backend';
import { stationName } from '../map-data';
import { Permission, SIM_TIME_SCALE } from '../models';
import { ConnectionStatus, RealtimeGateway } from '../realtime/realtime-gateway';
import { FleetStore } from '../../domain/fleet/fleet.store';
import { UiStore } from '../../domain/fleet/ui.store';
import { InsightsStore } from '../../domain/insights/insights.store';
import { KpiStore } from '../../domain/kpi/kpi.store';
import { CommandTrackerStore } from '../../domain/overrides/command-tracker.store';
import { TaskStore } from '../../domain/tasks/task.store';
import { CommandPaletteComponent } from './command-palette.component';
import { DialogHostComponent } from './dialog-host.component';
import { HelpDialogComponent } from './help-dialog.component';
import { TourComponent } from './tour.component';
import { TourService } from './tour.service';
import { NotificationService } from './notification.service';

interface NavItem { label: string; icon: string; route: string; perm: Permission; staffOnly?: boolean; }
const NAV: NavItem[] = [
  { label: 'Control center', icon: '◉', route: '/ops', perm: 'fleet:view:full' },
  { label: 'Tasks', icon: '☰', route: '/tasks', perm: 'task:read:all' },
  { label: 'AI Control', icon: '✦', route: '/ai', perm: 'fleet:view:full' },
  { label: 'KPIs', icon: '▤', route: '/kpi', perm: 'kpi:view:basic' },
  { label: 'Simulator', icon: '⚙', route: '/simulator', perm: 'simulation:run' },
  { label: 'Audit', icon: '✎', route: '/audit', perm: 'audit:view' },
  { label: 'New request', icon: '＋', route: '/request/new', perm: 'task:create', staffOnly: true },
  { label: 'My requests', icon: '☰', route: '/request/mine', perm: 'task:read:own', staffOnly: true },
  { label: 'Department', icon: '⌂', route: '/request/status', perm: 'fleet:view', staffOnly: true },
];

const STATUS_META: Record<ConnectionStatus, { label: string; cls: string; icon: string }> = {
  CONNECTING: { label: 'Connecting', cls: 'warn', icon: '◌' },
  SYNCING: { label: 'Syncing', cls: 'info', icon: '⟳' },
  LIVE: { label: 'Live', cls: 'ok', icon: '●' },
  DEGRADED: { label: 'Degraded', cls: 'warn', icon: '▲' },
  RECONNECTING: { label: 'Reconnecting', cls: 'crit', icon: '⟳' },
  OFFLINE: { label: 'Offline', cls: 'crit', icon: '✕' },
};

@Component({
  selector: 'scl-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DialogHostComponent, HasPermissionDirective, CommandPaletteComponent, HelpDialogComponent, TourComponent],
  template: `
    <header class="top">
      <a class="brand" [routerLink]="auth.landingRoute()"><span class="logo">✚</span><span class="name">SmartCare<b>Logistics</b></span></a>
      <label class="site"><span class="sr">Site</span>
        <select aria-label="Site and floor"><option>Klinikum Nord · Floor 1</option><option>Klinikum Nord · Floor 2</option></select>
      </label>
      <span class="grow"></span>

      <span class="chip" [class]="meta().cls" [attr.title]="'Latency ' + gw.latencyMs() + ' ms · resyncs ' + gw.resyncCount()">
        {{ meta().icon }} {{ meta().label }}
      </span>
      <ng-container *sclHasPermission="'fleet:view:full'">
        <span class="chip" [class]="fleet.system().hold ? 'crit' : fleet.system().mode === 'AUTO' ? 'ok' : 'warn'"
              [attr.title]="'Dispatch mode (server-provided)'">
          {{ fleet.system().hold ? '⏸ DISPATCH HOLD' : fleet.system().mode === 'AUTO' ? 'AUTO' : 'SEMI-AUTO' }}
        </span>
        <a class="bell" routerLink="/ops" [attr.aria-label]="insights.criticalCount() + ' critical alerts'">
          🔔@if (insights.criticalCount() > 0) { <span class="count">{{ insights.criticalCount() }}</span> }
        </a>
      </ng-container>

      <button class="btn sm palette-btn" type="button" (click)="ui.paletteOpen.set(true)" aria-label="Search and commands (Ctrl+K)" title="Search pages, robots, tasks and actions">
        <span aria-hidden="true">⌕</span> <span class="plabel">Search</span> <kbd class="kbd">Ctrl K</kbd>
      </button>
      <button class="btn ghost sm" type="button" (click)="ui.helpOpen.set(true)" aria-label="Help and settings" title="Help, shortcuts and settings (?)">❓</button>
      <button class="btn ghost sm" type="button" (click)="ui.toggleTheme()" [attr.aria-label]="'Switch to ' + (ui.theme() === 'dark' ? 'light' : 'dark') + ' theme'">
        {{ ui.theme() === 'dark' ? '☀' : '☾' }}
      </button>
      <div class="user">
        <div class="who"><strong>{{ auth.user().name }}</strong><small>{{ auth.user().roleLabel }}</small></div>
        <select aria-label="Demo: switch user" [value]="auth.user().id" (change)="switchUser($any($event.target).value)" title="Demo only — an OIDC login replaces this">
          @for (p of personas; track p.id) { <option [value]="p.id" [selected]="p.id === auth.user().id">{{ p.name }} — {{ p.roleLabel }}</option> }
        </select>
      </div>
    </header>

    @if (gw.status() !== 'LIVE' && gw.status() !== 'SYNCING' && gw.status() !== 'CONNECTING') {
      <div class="banner danger offline" role="alert">
        <strong>Live data interrupted — data may be outdated.</strong>
        <span class="muted">Controls that change fleet state are disabled until the connection is restored.</span>
        <span class="grow"></span>
        <button class="btn sm" type="button" (click)="gw.reconnect()">Retry now</button>
      </div>
    }

    <div class="body" [class.touch]="!auth.isOps()">
      <nav class="side" aria-label="Primary">
        @for (n of nav(); track n.route) {
          <a [routerLink]="n.route" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: false }">
            <span class="ic" aria-hidden="true">{{ n.icon }}</span><span class="lbl">{{ n.label }}</span>
          </a>
        }
      </nav>
      <main><router-outlet /></main>
    </div>

    <footer class="status" aria-label="System status">
      <span>WS {{ gw.latencyMs() }} ms</span>
      <span>Last event {{ lastAge() }}</span>
      @if (auth.isOps()) {
        <span>Fleet online {{ fleet.online() }}/{{ robotTotal() }}</span>
        <span>Resyncs {{ gw.resyncCount() }}</span>
      }
      <span class="faint">Hospital time ×{{ scale }}</span>
      <span class="grow"></span>
      @if (isMock) {
        <div class="mock">
          <button class="btn ghost sm" type="button" (click)="mockOpen.set(!mockOpen())" [attr.aria-expanded]="mockOpen()">🧪 Demo &amp; mock backend</button>
          @if (mockOpen()) {
            <div class="menu card" role="menu">
              <div class="panel-title">Demo scenarios</div>
              <button class="btn sm" role="menuitem" (click)="scenario('rush')">Morning rush (14 requests)</button>
              <button class="btn sm" role="menuitem" (click)="scenario('corridor')">Block corridor to Ward A</button>
              <button class="btn sm" role="menuitem" (click)="scenario('fault')">A robot reports a fault</button>
              <button class="btn sm" role="menuitem" (click)="scenario('calm')">Back to normal</button>
              <div class="panel-title">Failure modes</div>
              <button class="btn sm" role="menuitem" (click)="mock.dropConnection()">Drop WebSocket</button>
              <button class="btn sm" role="menuitem" (click)="mock.forceGap()">Force sequence gap</button>
              <button class="btn sm" role="menuitem" (click)="mute(true)">Mute Robot 3 telemetry</button>
              <button class="btn sm" role="menuitem" (click)="mute(false)">Unmute Robot 3</button>
              <button class="btn sm" role="menuitem" (click)="mock.setAi(false)">AI layer down</button>
              <button class="btn sm" role="menuitem" (click)="mock.setAi(true)">AI layer up</button>
            </div>
          }
        </div>
      }
    </footer>

    <div class="toasts" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [class]="t.kind" [attr.role]="t.kind === 'critical' || t.kind === 'error' ? 'alert' : 'status'" (click)="toast.dismiss(t.id)">
          {{ t.text }}
        </div>
      }
    </div>
    <scl-dialog-host />
    <scl-command-palette />
    <scl-help-dialog />
    <scl-tour />
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
    scl-dialog-host { display: contents; }
    .top { display: flex; align-items: center; gap: .75rem; padding: .5rem 1rem; background: var(--surface); border-bottom: 1px solid var(--border); }
    .brand { display: flex; align-items: center; gap: .5rem; color: var(--text); font-weight: 500; text-decoration: none; }
    .logo { background: var(--grad); color: var(--accent-contrast); border-radius: 10px; width: 1.8rem; height: 1.8rem; display: grid; place-items: center; font-weight: 800; }
    .name b { font-weight: 800; margin-left: .1rem; }
    .site select { min-height: 1.9rem; padding: .2rem .5rem; font-size: .8rem; }
    .sr { position: absolute; left: -9999px; }
    .bell { position: relative; font-size: 1.1rem; text-decoration: none; padding: 0 .3rem; }
    .count { position: absolute; top: -6px; right: -4px; background: var(--crit); color: #fff; border-radius: 999px; font-size: .65rem; font-weight: 800; padding: 0 .35rem; }
    .user { display: flex; align-items: center; gap: .6rem; }
    .who { display: flex; flex-direction: column; line-height: 1.15; text-align: right; }
    .who small { color: var(--text-faint); font-size: .7rem; }
    .user select { max-width: 12rem; min-height: 1.9rem; padding: .2rem .4rem; font-size: .75rem; }
    .offline { margin: .5rem 1rem 0; }
    .body { display: grid; grid-template-columns: 11.5rem minmax(0, 1fr); flex: 1; min-height: 0; }
    .side { display: flex; flex-direction: column; gap: .15rem; padding: .75rem .5rem; border-right: 1px solid var(--border); background: var(--surface); overflow-y: auto; }
    .side a { display: flex; align-items: center; gap: .6rem; padding: .6rem .75rem; border-radius: 10px; color: var(--text-dim); text-decoration: none; font-weight: 600; }
    .side a:hover { background: var(--surface-2); color: var(--text); }
    .side a.active { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--text); box-shadow: inset 3px 0 0 var(--accent); }
    .side a.active .ic { color: var(--accent); }
    .ic { width: 1.2rem; text-align: center; }
    main { min-width: 0; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
    .status { display: flex; align-items: center; gap: 1.1rem; padding: .25rem 1rem; font-size: .72rem; color: var(--text-dim); background: var(--surface); border-top: 1px solid var(--border); position: relative; }
    .mock { position: relative; }
    .palette-btn { gap: .4rem; display: inline-flex; align-items: center; }
    .menu .panel-title { padding: .2rem .2rem 0; }
    .menu { position: absolute; right: 0; bottom: 2.2rem; display: flex; flex-direction: column; gap: .3rem; padding: .5rem; z-index: 20; min-width: 12rem; box-shadow: var(--shadow); }
    .toasts { position: fixed; right: 1rem; bottom: 2.6rem; display: flex; flex-direction: column; gap: .5rem; z-index: 50; max-width: min(26rem, 92vw); }
    .toast { padding: .6rem .9rem; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); border-left-width: 4px; box-shadow: var(--shadow); cursor: pointer; font-size: .85rem; }
    .toast.success { border-left-color: var(--ok); } .toast.warning { border-left-color: var(--warn); }
    .toast.error, .toast.critical { border-left-color: var(--crit); } .toast.info { border-left-color: var(--info); }
    .toast.critical { background: color-mix(in srgb, var(--crit) 16%, var(--surface-2)); font-weight: 700; }
    @media (max-width: 767px) {
      .body { grid-template-columns: 1fr; }
      .side { position: fixed; bottom: 0; left: 0; right: 0; flex-direction: row; justify-content: space-around; z-index: 30; border-right: 0; border-top: 1px solid var(--border); padding: .25rem; }
      .side a { flex-direction: column; gap: .1rem; font-size: .65rem; padding: .3rem .4rem; }
      .side a.active { box-shadow: inset 0 3px 0 var(--accent); }
      .who, .site, .plabel, .palette-btn .kbd { display: none; }
      .status { padding-bottom: 3.6rem; flex-wrap: wrap; gap: .4rem .9rem; }
      .toasts { bottom: 5rem; }
    }
  `],
})
export class ShellComponent {
  protected readonly auth = inject(AuthService);
  protected readonly gw = inject(RealtimeGateway);
  protected readonly fleet = inject(FleetStore);
  protected readonly insights = inject(InsightsStore);
  protected readonly ui = inject(UiStore);
  protected readonly toast = inject(NotificationService);
  protected readonly mock = inject(MockControls);
  private readonly router = inject(Router);
  /** Stores subscribe to the gateway in their constructors; create them all before the first snapshot arrives. */
  private readonly tasks = inject(TaskStore);
  private readonly eagerStores = [this.tasks, inject(KpiStore), inject(CommandTrackerStore)];
  private readonly tour = inject(TourService);

  protected readonly isMock = inject(IS_MOCK_BACKEND);
  protected readonly mockOpen = signal(false);
  protected readonly personas = PERSONAS;
  protected readonly scale = SIM_TIME_SCALE;
  protected readonly meta = computed(() => STATUS_META[this.gw.status()]);
  protected readonly robotTotal = computed(() => this.fleet.robotViews().length);
  protected readonly nav = computed(() =>
    NAV.filter((n) => this.auth.can(n.perm) && (!n.staffOnly || !this.auth.isOps())));
  protected readonly lastAge = computed(() => {
    this.fleet.tick();
    const last = this.gw.lastMessageAt();
    return last ? `${Math.max(0, Math.round((Date.now() - last) / 1000))} s ago` : '—';
  });

  constructor() {
    // Identity → subscription scope (staff never receive fleet-wide topics).
    effect(() => {
      const u = this.auth.user();
      this.gw.start({ userId: u.id, role: u.role });
    });

    // Offer the guided tour once per audience, after the first data has arrived.
    effect(() => {
      if (this.gw.status() === 'LIVE') untracked(() => setTimeout(() => this.tour.maybeAutoStart(), 1200));
    });

    // Staff get plain-language updates about their own requests (no polling needed).
    const seen = new Map<string, string>();
    effect(() => {
      const mine = this.tasks.mine();
      untracked(() => {
        for (const t of mine) {
          const prev = seen.get(t.id);
          seen.set(t.id, t.status);
          if (!prev || prev === t.status || this.auth.isOps()) continue;
          const route = `${stationName(t.from)} → ${stationName(t.to)}`;
          if (t.status === 'TO_PICKUP' || t.status === 'ASSIGNED') this.toast.push('info', `A robot is on its way to pick up: ${route}`);
          else if (t.status === 'IN_TRANSIT') this.toast.push('info', `Picked up. Your delivery is on the way: ${route}`);
          else if (t.status === 'DELIVERED') this.toast.push('success', `Delivered ✔ ${t.item} arrived at ${stationName(t.to)}`, 8000);
        }
      });
    });
  }

  /** Global shortcuts. Ignored while typing in a field. */
  @HostListener('document:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent): void {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); this.ui.paletteOpen.update((v) => !v); return; }
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.ctrlKey || ev.metaKey || ev.altKey || this.ui.paletteOpen() || this.tour.active()) return;
    if (ev.key === '?') { ev.preventDefault(); this.ui.helpOpen.update((v) => !v); }
    if (!this.auth.isOps()) return;
    if (ev.key === '1') this.ui.dockTab.set('tasks');
    else if (ev.key === '2') this.ui.dockTab.set('fleet');
    else if (ev.key === '3') this.ui.dockTab.set('kpi');
    else if (ev.key.toLowerCase() === 'n' && this.auth.can('task:read:all')) { ev.preventDefault(); void this.router.navigateByUrl('/tasks/new'); }
  }

  protected scenario(name: 'rush' | 'corridor' | 'fault' | 'calm'): void {
    this.toast.push('info', this.mock.scenario(name));
    this.mockOpen.set(false);
    if (name !== 'calm') void this.router.navigateByUrl('/ops');
  }

  protected switchUser(id: string): void {
    this.auth.switchPersona(id);
    this.router.navigateByUrl(this.auth.landingRoute());
  }

  protected mute(m: boolean): void { this.mock.muteRobot('R3', m); }
}
