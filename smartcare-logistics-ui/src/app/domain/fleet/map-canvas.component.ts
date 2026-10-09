import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, effect, inject, input, output, signal, viewChild,
} from '@angular/core';
import { KIND_COLOR, MAP_EDGES, MAP_NODES, NODE_BY_ID, STATION_NODES, WORLD } from '../../core/map-data';
import { Task } from '../../core/models';
import { ClockService } from '../../core/realtime/realtime-gateway';
import { DurationPipe, ROBOT_STATUS_COLOR, ROBOT_STATUS_ICON, ROBOT_STATUS_LABEL } from '../../shared/util';
import { TaskStore } from '../tasks/task.store';
import { FleetStore, RobotView } from './fleet.store';
import { UiStore } from './ui.store';

interface Palette { bg: string; corridor: string; line: string; text: string; dim: string; room: string; }
const FRAME_MS = 33; // ≤ 30 fps render budget

/**
 * Canvas map. Network rate and render rate are decoupled: stores update on telemetry, this loop
 * redraws at ≤30 fps and dead-reckons robot positions between samples (blueprint 1.3).
 * Not zone-dependent: the app is zoneless and the loop reads signals non-reactively.
 */
@Component({
  selector: 'scl-map-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap" #wrap>
      <canvas #cv role="img" aria-label="Live hospital map. A list view of the same data is available in the Fleet tab."
        [class.picking]="!!ui.pick()"
        (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up($event)" (pointerleave)="leave()"
        (wheel)="wheel($event)" (dblclick)="resetView()"></canvas>

      @if (hover(); as h) {
        <div class="tip" [style.left.px]="h.x + 14" [style.top.px]="h.y + 14">
          <strong>{{ h.r.name }}</strong>
          <span class="chip" [style.--c]="color(h.r)">{{ icon(h.r) }} {{ label(h.r) }}</span>
          <div>Battery {{ h.r.battery.toFixed(0) }} %</div>
          @if (h.task) { <div>{{ h.task.id }} · ETA {{ h.task.etaSec | duration }}</div> }
        </div>
      }
      @if (ui.pick(); as p) {
        <div class="pickhint">Click a waypoint to send <strong>{{ p.robotId }}</strong> there · <kbd>Esc</kbd> to cancel</div>
      }
      @if (mode() === 'ops') {
        <details class="legend">
          <summary>Legend</summary>
          <div class="items">
            @for (s of legend; track s) {
              <span><i [style.background]="statusColor(s)"></i>{{ statusIcon(s) }} {{ statusLabel(s) }}</span>
            }
            <span><i class="heat"></i> Predicted congestion</span>
          </div>
        </details>
      }
    </div>
  `,
  styles: [`
    :host { display: block; position: relative; width: 100%; height: 100%; min-height: 220px; }
    .wrap { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; }
    canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
    canvas:active { cursor: grabbing; }
    canvas.picking { cursor: crosshair; }
    .tip { position: absolute; z-index: 3; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
      padding: .45rem .6rem; font-size: .75rem; pointer-events: none; display: flex; flex-direction: column; gap: .15rem; box-shadow: var(--shadow); }
    .chip { color: var(--c); font-weight: 600; }
    .pickhint { position: absolute; left: 50%; top: .6rem; transform: translateX(-50%); background: var(--accent); color: var(--accent-contrast);
      padding: .4rem .8rem; border-radius: 999px; font-size: .8rem; z-index: 3; box-shadow: var(--shadow); }
    kbd { background: rgba(255,255,255,.2); border-radius: 4px; padding: 0 .3rem; }
    .legend { position: absolute; right: .6rem; bottom: .6rem; width: max-content; max-width: 14rem;
      background: color-mix(in srgb, var(--surface) 88%, transparent); border: 1px solid var(--border); border-radius: 8px;
      padding: .35rem .6rem; font-size: .68rem; color: var(--text-dim); }
    .legend summary { cursor: pointer; font-weight: 600; }
    .legend .items { display: flex; flex-direction: column; gap: .2rem; margin-top: .35rem; }
    .legend i { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; margin-right: .25rem; }
    .legend i.heat { background: radial-gradient(circle, rgba(255,90,95,.9), rgba(255,90,95,.1)); }
  `],
  imports: [DurationPipe],
})
export class MapCanvasComponent {
  readonly mode = input<'ops' | 'track'>('ops');
  readonly trackTaskId = input<string | null>(null);
  readonly nodePicked = output<string>();
  readonly robotClicked = output<string>();

  protected readonly ui = inject(UiStore);
  private readonly fleet = inject(FleetStore);
  private readonly tasks = inject(TaskStore);
  private readonly clock = inject(ClockService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');
  private readonly wrapRef = viewChild.required<ElementRef<HTMLElement>>('wrap');
  protected readonly hover = signal<{ x: number; y: number; r: RobotView; task: Task | undefined } | null>(null);
  protected readonly legend = ['IDLE', 'EN_ROUTE_TO_PICKUP', 'CARRYING', 'WAITING', 'CHARGING', 'PAUSED', 'MANUAL_OVERRIDE', 'FAULT', 'STALE'] as const;

  // view state
  private cssW = 800;
  private cssH = 500;
  private dpr = 1;
  private cx = WORLD.w / 2;
  private cy = WORLD.h / 2;
  private zoom = 1;
  private target: { cx: number; cy: number; zoom: number } | null = null;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private pointer = { x: -1, y: -1 };
  private raf = 0;
  private lastFrame = 0;
  private palette: Palette = { bg: '#0d141c', corridor: '#1b2733', line: '#2c3d4e', text: '#cfd9e4', dim: '#7e8fa1', room: '#16212c' };
  private paletteAt = 0;

  constructor() {
    afterNextRender(() => {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.wrapRef().nativeElement);
      this.resize();
      const loop = (t: number) => {
        this.raf = requestAnimationFrame(loop);
        if (t - this.lastFrame >= FRAME_MS) { this.lastFrame = t; this.draw(t); }
      };
      this.raf = requestAnimationFrame(loop);
      this.destroyRef.onDestroy(() => { cancelAnimationFrame(this.raf); ro.disconnect(); });
    });

    // "Show on map" from insights → fit the affected zone
    effect(() => {
      const f = this.ui.focusZone();
      if (!f) return;
      const z = MAP_EDGES.find((e) => e.id === f.zoneId);
      if (!z) return;
      const a = NODE_BY_ID[z.a].pos, b = NODE_BY_ID[z.b].pos;
      this.ui.followRobotId.set(null);
      this.target = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom: 2 };
    });
  }

  protected color(r: RobotView) { return ROBOT_STATUS_COLOR[r.viewStatus]; }
  protected icon(r: RobotView) { return ROBOT_STATUS_ICON[r.viewStatus]; }
  protected label(r: RobotView) { return ROBOT_STATUS_LABEL[r.viewStatus]; }
  protected statusColor(s: keyof typeof ROBOT_STATUS_COLOR) { return ROBOT_STATUS_COLOR[s]; }
  protected statusIcon(s: keyof typeof ROBOT_STATUS_ICON) { return ROBOT_STATUS_ICON[s]; }
  protected statusLabel(s: keyof typeof ROBOT_STATUS_LABEL) { return ROBOT_STATUS_LABEL[s]; }

  protected resetView(): void { this.target = { cx: WORLD.w / 2, cy: WORLD.h / 2, zoom: 1 }; this.ui.followRobotId.set(null); }

  // ───────────── geometry helpers ─────────────
  private baseScale(): number { return Math.min((this.cssW - 24) / WORLD.w, (this.cssH - 24) / WORLD.h); }
  private scale(): number { return this.baseScale() * this.zoom; }
  private sx(x: number): number { return (x - this.cx) * this.scale() + this.cssW / 2; }
  private sy(y: number): number { return (y - this.cy) * this.scale() + this.cssH / 2; }
  private wx(px: number): number { return (px - this.cssW / 2) / this.scale() + this.cx; }
  private wy(py: number): number { return (py - this.cssH / 2) / this.scale() + this.cy; }

  private resize(): void {
    const el = this.wrapRef().nativeElement;
    this.cssW = Math.max(100, el.clientWidth);
    this.cssH = Math.max(100, el.clientHeight);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = this.canvasRef().nativeElement;
    cv.width = Math.round(this.cssW * this.dpr);
    cv.height = Math.round(this.cssH * this.dpr);
  }

  /** Dead-reckoned display position between telemetry samples (clamped at the next waypoint). */
  private displayPos(r: RobotView): { x: number; y: number } {
    if (r.stale || r.speed <= 0.01) return r.pos;
    const dt = Math.min(0.35, Math.max(0, (this.clock.now() - r.ts) / 1000));
    let step = r.speed * dt;
    const next = r.route[0] ? NODE_BY_ID[r.route[0]]?.pos : null;
    if (next) step = Math.min(step, Math.hypot(next.x - r.pos.x, next.y - r.pos.y));
    return { x: r.pos.x + Math.cos(r.heading) * step, y: r.pos.y + Math.sin(r.heading) * step };
  }

  // ───────────── input ─────────────
  protected down(ev: PointerEvent): void {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.drag = { x: ev.clientX, y: ev.clientY, moved: false };
  }

  protected move(ev: PointerEvent): void {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    this.pointer = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    if (this.drag) {
      const dx = ev.clientX - this.drag.x, dy = ev.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.cx -= dx / this.scale();
        this.cy -= dy / this.scale();
        this.drag.x = ev.clientX; this.drag.y = ev.clientY;
        this.target = null;
        this.ui.followRobotId.set(null);
        this.hover.set(null);
        return;
      }
    }
    if (this.mode() !== 'ops') return;
    const hit = this.hitRobot(this.pointer.x, this.pointer.y);
    const cur = this.hover();
    if (!hit) { if (cur) this.hover.set(null); return; }
    this.hover.set({ x: this.pointer.x, y: this.pointer.y, r: hit, task: this.tasks.forRobot(hit.id) });
  }

  protected up(ev: PointerEvent): void {
    const wasClick = this.drag && !this.drag.moved;
    this.drag = null;
    if (!wasClick) return;
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (this.ui.pick()) {
      const n = this.hitNode(px, py);
      if (n) this.nodePicked.emit(n);
      return;
    }
    if (this.mode() !== 'ops') return;
    const hit = this.hitRobot(px, py);
    if (hit) { this.ui.select({ kind: 'robot', id: hit.id }); this.robotClicked.emit(hit.id); }
    else this.ui.select(null);
  }

  protected leave(): void { this.drag = null; this.hover.set(null); }

  protected wheel(ev: WheelEvent): void {
    ev.preventDefault();
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const wx = this.wx(px), wy = this.wy(py);
    this.zoom = Math.min(4, Math.max(0.7, this.zoom * Math.exp(-ev.deltaY * 0.0015)));
    // keep the world point under the cursor fixed
    this.cx = wx - (px - this.cssW / 2) / this.scale();
    this.cy = wy - (py - this.cssH / 2) / this.scale();
    this.target = null;
  }

  private hitRobot(px: number, py: number): RobotView | null {
    let best: RobotView | null = null;
    let bd = 18;
    for (const r of this.fleet.robotViews()) {
      const p = this.displayPos(r);
      const d = Math.hypot(this.sx(p.x) - px, this.sy(p.y) - py);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  private hitNode(px: number, py: number): string | null {
    let best: string | null = null;
    let bd = 22;
    for (const n of MAP_NODES) {
      if (n.kind === 'CHARGING') continue;
      const d = Math.hypot(this.sx(n.pos.x) - px, this.sy(n.pos.y) - py);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  }

  // ───────────── rendering ─────────────
  private readPalette(t: number): void {
    if (t - this.paletteAt < 1000) return;
    this.paletteAt = t;
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    this.palette = {
      bg: v('--map-bg', this.palette.bg), corridor: v('--map-corridor', this.palette.corridor), line: v('--map-line', this.palette.line),
      text: v('--text', this.palette.text), dim: v('--text-dim', this.palette.dim), room: v('--map-room', this.palette.room),
    };
  }

  private draw(t: number): void {
    const cv = this.canvasRef().nativeElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    this.readPalette(t);
    this.animateView();
    const { w, h } = { w: this.cssW, h: this.cssH };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, w, h);

    const sc = this.scale();
    const layers = this.ui.layers();
    const ops = this.mode() === 'ops';
    const robots = this.fleet.robotViews();
    const trackTask = this.mode() === 'track' ? this.tasks.byId(this.trackTaskId()) : undefined;

    // corridors
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.palette.corridor;
    ctx.lineWidth = 3.6 * sc;
    ctx.beginPath();
    for (const e of MAP_EDGES) { const a = NODE_BY_ID[e.a].pos, b = NODE_BY_ID[e.b].pos; ctx.moveTo(this.sx(a.x), this.sy(a.y)); ctx.lineTo(this.sx(b.x), this.sy(b.y)); }
    ctx.stroke();

    // current congestion + blocked zones
    if (ops && layers.congestionNow) {
      for (const z of Object.values(this.fleet.zones())) {
        const a = NODE_BY_ID[z.a].pos, b = NODE_BY_ID[z.b].pos;
        if (z.blocked) {
          ctx.strokeStyle = 'rgba(255,90,95,.55)'; ctx.lineWidth = 3.6 * sc; ctx.setLineDash([sc * 1.2, sc * 0.9]);
        } else if (z.load > 0) {
          ctx.strokeStyle = z.load >= 1 ? 'rgba(255,90,95,.45)' : 'rgba(242,177,52,.38)'; ctx.lineWidth = 3.6 * sc; ctx.setLineDash([]);
        } else continue;
        ctx.beginPath(); ctx.moveTo(this.sx(a.x), this.sy(a.y)); ctx.lineTo(this.sx(b.x), this.sy(b.y)); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // nav graph
    if (layers.navGraph || this.ui.pick()) {
      ctx.strokeStyle = this.palette.line; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (const e of MAP_EDGES) { const a = NODE_BY_ID[e.a].pos, b = NODE_BY_ID[e.b].pos; ctx.moveTo(this.sx(a.x), this.sy(a.y)); ctx.lineTo(this.sx(b.x), this.sy(b.y)); }
      ctx.stroke(); ctx.setLineDash([]);
    }

    // department rooms
    const queue = this.fleet.stations();
    const hot = new Set<string>();
    if (trackTask) { hot.add(trackTask.from); hot.add(trackTask.to); }
    for (const n of STATION_NODES) {
      const k = n.kind!;
      const rw = (k === 'CHARGING' ? 9 : 14) * sc, rh = (k === 'CHARGING' ? 5 : 8.5) * sc;
      const x = this.sx(n.pos.x) - rw / 2, y = this.sy(n.pos.y) - rh / 2;
      ctx.fillStyle = this.palette.room; this.roundRect(ctx, x, y, rw, rh, 6); ctx.fill();
      ctx.strokeStyle = KIND_COLOR[k]; ctx.globalAlpha = hot.has(n.id) ? 1 : 0.55; ctx.lineWidth = hot.has(n.id) ? 2.5 : 1.3;
      this.roundRect(ctx, x, y, rw, rh, 6); ctx.stroke(); ctx.globalAlpha = 1;
      if (layers.stations || !ops) {
        ctx.fillStyle = this.palette.text; ctx.font = `600 ${Math.max(9, Math.min(13, 1.7 * sc))}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.name, this.sx(n.pos.x), this.sy(n.pos.y) - (hot.has(n.id) ? 4 : 0));
        if (trackTask && hot.has(n.id)) {
          ctx.fillStyle = KIND_COLOR[k]; ctx.font = `600 ${Math.max(8, Math.min(11, 1.3 * sc))}px system-ui, sans-serif`;
          ctx.fillText(n.id === trackTask.from ? 'PICKUP' : 'DESTINATION', this.sx(n.pos.x), this.sy(n.pos.y) + 9);
        }
        const q = queue[n.id]?.queue ?? 0;
        if (ops && q > 0) {
          const bx = x + rw - 2, by = y + 2;
          ctx.fillStyle = '#f2b134'; ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#1a1200'; ctx.font = '700 10px system-ui'; ctx.fillText(String(q), bx, by + 0.5);
        }
      }
    }

    // predicted congestion hot-spots
    if (ops && layers.heat) {
      for (const p of this.fleet.predictionsFor(this.ui.horizon())) {
        const px = this.sx(p.center.x), py = this.sy(p.center.y), pr = p.radius * sc;
        const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, `rgba(255,90,95,${0.35 + p.severity * 0.4})`);
        g.addColorStop(1, 'rgba(255,90,95,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
        const hl = this.ui.highlightZoneId() === p.zoneId;
        ctx.strokeStyle = hl ? '#ffffff' : 'rgba(255,90,95,.8)'; ctx.lineWidth = hl ? 2.5 : 1.2; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(px, py, pr * 0.62, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = this.palette.text; ctx.font = '600 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`+${p.horizonMin} min · ${(p.confidence * 100).toFixed(0)} %`, px, py);
      }
    }

    const sel = this.ui.selection();
    const shown = this.mode() === 'track' ? robots.filter((r) => r.id === trackTask?.robotId) : robots;

    // routes
    if (layers.routes || !ops) {
      for (const r of shown) {
        if (!r.route.length) continue;
        const selected = sel?.kind === 'robot' && sel.id === r.id;
        const p = this.displayPos(r);
        const pts = [p, ...r.route.map((n) => NODE_BY_ID[n].pos)];
        ctx.strokeStyle = ROBOT_STATUS_COLOR[r.viewStatus];
        ctx.globalAlpha = selected || !ops ? 0.95 : 0.35;
        ctx.lineWidth = selected || !ops ? 3 : 1.6; ctx.setLineDash([]);
        this.poly(ctx, pts);
        if (r.plan.length) {
          ctx.setLineDash([6, 5]); ctx.globalAlpha *= 0.8;
          this.poly(ctx, [pts[pts.length - 1], ...r.plan.map((n) => NODE_BY_ID[n].pos)]);
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
      }
    }

    // robots
    for (const r of shown) this.drawRobot(ctx, r, sel?.kind === 'robot' && sel.id === r.id, t, sc);

    // pick-mode waypoint targets
    if (this.ui.pick()) {
      const hn = this.hitNode(this.pointer.x, this.pointer.y);
      for (const n of MAP_NODES) {
        if (n.kind === 'CHARGING') continue;
        ctx.fillStyle = hn === n.id ? '#ffffff' : 'rgba(79,156,249,.9)';
        ctx.beginPath(); ctx.arc(this.sx(n.pos.x), this.sy(n.pos.y), hn === n.id ? 8 : 5, 0, Math.PI * 2); ctx.fill();
      }
    }

    if (this.mode() === 'ops' && robots.length === 0) {
      ctx.fillStyle = this.palette.dim; ctx.font = '14px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('Waiting for fleet telemetry…', w / 2, h / 2);
    }
  }

  private drawRobot(ctx: CanvasRenderingContext2D, r: RobotView, selected: boolean, t: number, sc: number): void {
    const p = this.displayPos(r);
    const x = this.sx(p.x), y = this.sy(p.y);
    const rad = Math.max(8, 1.7 * sc);
    const col = ROBOT_STATUS_COLOR[r.viewStatus];
    ctx.save();
    ctx.globalAlpha = r.stale ? 0.5 : 1;

    if (r.viewStatus === 'FAULT') {
      const pulse = 0.5 + 0.5 * Math.sin(t / 220);
      ctx.strokeStyle = `rgba(255,90,95,${0.4 + pulse * 0.5})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, rad + 6 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
    } else if (r.viewStatus === 'WAITING') {
      const pulse = (t % 1200) / 1200;
      ctx.strokeStyle = `rgba(242,177,52,${1 - pulse})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, rad + pulse * 12, 0, Math.PI * 2); ctx.stroke();
    }
    if (selected) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, rad + 6, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.translate(x, y);
    ctx.rotate(r.heading);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(rad * 1.25, 0); ctx.lineTo(-rad * 0.9, rad * 0.85); ctx.lineTo(-rad * 0.5, 0); ctx.lineTo(-rad * 0.9, -rad * 0.85); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = r.viewStatus === 'MANUAL_OVERRIDE' ? '#e24fc2' : 'rgba(0,0,0,.55)'; ctx.lineWidth = r.viewStatus === 'MANUAL_OVERRIDE' ? 3 : 1.2; ctx.stroke();
    ctx.rotate(-r.heading);

    if (r.status === 'CARRYING') { ctx.fillStyle = '#fff'; ctx.fillRect(-3, -3, 6, 6); }
    ctx.font = '700 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = this.palette.text;
    const glyph = ROBOT_STATUS_ICON[r.viewStatus];
    if (this.ui.layers().labels || this.mode() === 'track') ctx.fillText(`${r.id} ${glyph}`, 0, -rad - 4);
    ctx.restore();
  }

  private poly(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]): void {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(this.sx(p.x), this.sy(p.y)) : ctx.moveTo(this.sx(p.x), this.sy(p.y))));
    ctx.stroke();
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private animateView(): void {
    const follow = this.ui.followRobotId();
    if (follow) {
      const r = this.fleet.robotViewById()[follow];
      if (r) { const p = this.displayPos(r); this.cx += (p.x - this.cx) * 0.15; this.cy += (p.y - this.cy) * 0.15; this.zoom += (Math.max(this.zoom, 1.8) - this.zoom) * 0.1; }
    } else if (this.target) {
      const k = 0.14;
      this.cx += (this.target.cx - this.cx) * k;
      this.cy += (this.target.cy - this.cy) * k;
      this.zoom += (this.target.zoom - this.zoom) * k;
      if (Math.abs(this.target.cx - this.cx) < 0.05 && Math.abs(this.target.cy - this.cy) < 0.05 && Math.abs(this.target.zoom - this.zoom) < 0.01) this.target = null;
    }
  }
}

