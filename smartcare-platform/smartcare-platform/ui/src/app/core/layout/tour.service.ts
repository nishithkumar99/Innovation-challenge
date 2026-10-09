import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';

export interface TourStep { title: string; body: string; target?: string; }

const OPS_STEPS: TourStep[] = [
  { title: 'Welcome to the control center', body: 'This is a live view of the robot fleet. A short tour shows where everything is. You can leave at any time with Esc and replay it from the Help menu.' },
  { title: 'Connection and dispatch mode', body: 'Green “Live” means the data is current. If the connection drops, a banner appears and controls that change the fleet are disabled until it is back.', target: 'header.top .chip' },
  { title: 'Fleet-wide controls', body: 'Hold or resume dispatching, switch between automatic and semi-automatic mode, or block a corridor. Every change asks for a reason and is recorded in the audit log.', target: 'scl-fleet-controls' },
  { title: 'Live map', body: 'Click a robot or a task to see details. Scroll to zoom, drag to pan, press F to follow the selected robot. Red areas are predicted congestion. Use the +5 / +15 / +30 min buttons to look ahead.', target: 'scl-map-canvas' },
  { title: 'AI alerts with suggested actions', body: 'When the system expects a bottleneck it explains why and proposes a fix. Apply runs it, Modify lets you adjust it, Dismiss hides it. Nothing happens without your click.', target: 'scl-insights-panel' },
  { title: 'Queue, fleet and KPIs', body: 'Switch between the task queue, the fleet table and live key figures. Press 1, 2 or 3 to change tabs quickly.', target: 'section.dock' },
  { title: 'Find anything fast', body: 'Press Ctrl+K (⌘K on Mac) to jump to any page, robot or task, or to run a demo scenario such as a morning rush.', target: 'button.palette-btn' },
  { title: 'Try other roles', body: 'Use this menu to see the app as a nurse, a charge nurse, a manager or an admin. Each role only sees what it is allowed to do.', target: '.user select' },
];

const STAFF_STEPS: TourStep[] = [
  { title: 'Welcome', body: 'Request a delivery in a few taps and follow it until it arrives. This short tour shows where things are.' },
  { title: 'Your menu', body: 'New request creates a delivery. My requests shows the status of everything you asked for. Department shows how busy transport is.', target: 'nav.side' },
  { title: 'Find anything fast', body: 'Press Ctrl+K (⌘K on Mac) to jump to a page or one of your requests.', target: 'button.palette-btn' },
  { title: 'Try other roles', body: 'Use this menu to see the app as a fleet operator or manager.', target: '.user select' },
];

/** Guided tour state. Shown automatically once per audience (operators / staff) and replayable from Help. */
@Injectable({ providedIn: 'root' })
export class TourService {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  private readonly seen = new Set<string>();
  readonly active = signal(false);
  readonly index = signal(0);
  readonly steps = computed(() => (this.auth.isOps() ? OPS_STEPS : STAFF_STEPS));
  readonly step = computed(() => this.steps()[this.index()]);
  readonly isLast = computed(() => this.index() >= this.steps().length - 1);

  private key() { return `scl.tour.${this.auth.isOps() ? 'ops' : 'staff'}`; }

  /** Opens the tour on the persona's landing page so the highlighted elements exist. */
  async start(): Promise<void> {
    await this.router.navigateByUrl(this.auth.landingRoute() === '/request' ? '/request/mine' : this.auth.landingRoute());
    this.index.set(0);
    setTimeout(() => this.active.set(true), 350);
  }

  maybeAutoStart(): void {
    if (this.seen.has(this.key())) return;
    try { if (localStorage.getItem(this.key())) return; } catch { /* storage blocked: show once per page load */ }
    void this.start();
  }

  next(): void { this.isLast() ? this.finish() : this.index.update((i) => i + 1); }
  prev(): void { this.index.update((i) => Math.max(0, i - 1)); }
  finish(): void {
    this.active.set(false);
    this.seen.add(this.key());
    try { localStorage.setItem(this.key(), '1'); } catch { /* ignore */ }
  }
}
