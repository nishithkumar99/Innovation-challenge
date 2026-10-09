import { Injectable, effect, signal } from '@angular/core';
import { HorizonMin } from '../../core/models';

export interface Selection { kind: 'robot' | 'task'; id: string; }
export interface MapLayers {
  navGraph: boolean; congestionNow: boolean; heat: boolean; routes: boolean; stations: boolean; labels: boolean;
}
const KEY = 'scl.ui.layers';
function read<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function write(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } }
const DEFAULT_LAYERS: MapLayers = { navGraph: true, congestionNow: true, heat: true, routes: true, stations: true, labels: true };

/** UI/session state. Only non-sensitive preferences are persisted (per blueprint 4.4). */
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly selection = signal<Selection | null>(null);
  readonly layers = signal<MapLayers>(this.restore());
  readonly horizon = signal<HorizonMin>(read<HorizonMin>('scl.horizon', 5));
  readonly followRobotId = signal<string | null>(null);
  /** Map-pick mode used by "Reroute…" (operator clicks a waypoint on the map). */
  readonly pick = signal<{ kind: 'goto'; robotId: string } | null>(null);
  readonly highlightZoneId = signal<string | null>(null);
  readonly focusZone = signal<{ zoneId: string; nonce: number } | null>(null);
  readonly dockTab = signal<'tasks' | 'fleet' | 'kpi'>(read<'tasks' | 'fleet' | 'kpi'>('scl.dock', 'tasks'));
  readonly textSize = signal<'s' | 'm' | 'l'>(read<'s' | 'm' | 'l'>('scl.text', 'm'));
  /** Overlays that can be opened from anywhere (header, palette, keyboard). */
  readonly paletteOpen = signal(false);
  readonly helpOpen = signal(false);
  readonly settingsOpen = signal(false);
  readonly theme = signal<'dark' | 'light'>((localStorage.getItem('scl.theme') as 'dark' | 'light') || 'dark');

  constructor() {
    effect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(this.layers())); } catch { /* ignore */ }
    });
    effect(() => write('scl.horizon', this.horizon()));
    effect(() => write('scl.dock', this.dockTab()));
    effect(() => {
      const t = this.textSize();
      document.documentElement.dataset['text'] = t;
      write('scl.text', t);
    });
    effect(() => {
      const t = this.theme();
      document.documentElement.dataset['theme'] = t;
      try { localStorage.setItem('scl.theme', t); } catch { /* ignore */ }
    });
  }

  select(sel: Selection | null): void { this.selection.set(sel); }
  toggleLayer(k: keyof MapLayers): void { this.layers.update((l) => ({ ...l, [k]: !l[k] })); }
  showZone(zoneId: string): void { this.focusZone.set({ zoneId, nonce: Date.now() }); }
  toggleTheme(): void { this.theme.update((t) => (t === 'dark' ? 'light' : 'dark')); }

  private restore(): MapLayers {
    try { return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULT_LAYERS; }
  }
}
