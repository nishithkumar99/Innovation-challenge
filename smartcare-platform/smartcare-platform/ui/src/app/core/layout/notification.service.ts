import { Injectable, inject, signal } from '@angular/core';
import { SoundService } from './sound.service';

export type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'critical';
export interface Toast { id: number; kind: ToastKind; text: string; }

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private nextId = 1;
  readonly toasts = signal<Toast[]>([]);
  readonly muted = signal(false);
  private readonly sound = inject(SoundService);

  push(kind: ToastKind, text: string, ttlMs = 4500): void {
    if (this.muted() && kind !== 'error') return;
    if (kind === 'critical') this.sound.beep('critical');
    const id = this.nextId++;
    this.toasts.update((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => this.dismiss(id), kind === 'critical' ? ttlMs * 2 : ttlMs);
  }

  dismiss(id: number): void { this.toasts.update((t) => t.filter((x) => x.id !== id)); }
}
