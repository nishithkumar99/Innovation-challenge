import { Injectable, effect, signal } from '@angular/core';

const KEY = 'scl.sound';

/** Optional audible alert for critical events. Off by default; browsers only allow audio after a user gesture. */
@Injectable({ providedIn: 'root' })
export class SoundService {
  readonly enabled = signal(this.restore());
  private ctx: AudioContext | null = null;

  constructor() {
    effect(() => { try { localStorage.setItem(KEY, JSON.stringify(this.enabled())); } catch { /* ignore */ } });
  }

  toggle(): void {
    this.enabled.update((v) => !v);
    if (this.enabled()) this.beep('info'); // confirms the setting and unlocks audio
  }

  beep(kind: 'critical' | 'info' = 'critical'): void {
    if (!this.enabled()) return;
    try {
      this.ctx ??= new AudioContext();
      const now = this.ctx.currentTime;
      const tones = kind === 'critical' ? [880, 660, 880] : [660];
      tones.forEach((f, i) => {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, now + i * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.16 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.14);
        osc.connect(gain).connect(this.ctx!.destination);
        osc.start(now + i * 0.16);
        osc.stop(now + i * 0.16 + 0.16);
      });
    } catch { /* audio unavailable */ }
  }

  private restore(): boolean {
    try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
  }
}
