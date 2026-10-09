import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, Subject, Subscription, filter, map } from 'rxjs';
import { FleetTransport } from '../backend/fleet-backend';
import { Envelope, Snapshot, SubscriptionScope, TopicName } from '../models';

export type ConnectionStatus = 'CONNECTING' | 'SYNCING' | 'LIVE' | 'DEGRADED' | 'RECONNECTING' | 'OFFLINE';

/** Server-time offset so countdowns/staleness never depend on the operator's local clock. */
@Injectable({ providedIn: 'root' })
export class ClockService {
  private offset = 0;
  sync(serverTs: number) { this.offset = serverTs - Date.now(); }
  now(): number { return Date.now() + this.offset; }
}

/**
 * Single multiplexed connection. Lifecycle (blueprint 4.5.2):
 * CONNECTING → SYNCING (subscribe first, buffer, fetch snapshot) → LIVE ⇄ DEGRADED → RECONNECTING.
 * A sequence gap forces a resync; the socket stays open.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeGateway {
  private readonly transport = inject(FleetTransport);
  private readonly clock = inject(ClockService);

  readonly status = signal<ConnectionStatus>('CONNECTING');
  readonly lastMessageAt = signal(0);
  readonly latencyMs = signal(0);
  readonly resyncCount = signal(0);
  readonly isLive = computed(() => this.status() === 'LIVE');
  /** Live data is trustworthy only while LIVE. Controls that mutate state depend on this. */
  readonly canControl = computed(() => this.status() === 'LIVE');

  /** Emits a full snapshot on every (re)sync — stores replace their state with it. */
  readonly snapshot$ = new Subject<Snapshot>();
  private readonly bus = new Subject<Envelope>();

  private scope: SubscriptionScope | null = null;
  private socket?: Subscription;
  private snapSub?: Subscription;
  private snapTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private buffer: Envelope[] = [];
  private syncing = true;
  private lastSeq = 0;
  private attempt = 0;

  topic$<T>(name: TopicName): Observable<T> {
    return this.bus.pipe(filter((e) => e.topic === name), map((e) => e.payload as T));
  }

  /** (Re)starts the connection for a subscription scope (called when the identity changes). */
  start(scope: SubscriptionScope): void {
    if (this.scope && this.scope.userId === scope.userId && this.socket) return;
    this.scope = scope;
    this.teardown();
    this.attempt = 0;
    this.open();
    this.watchdog ??= setInterval(() => this.checkHeartbeat(), 1000);
  }

  /** Manual reconnect (e.g. the "Retry" button on the offline banner). */
  reconnect(): void {
    if (!this.scope) return;
    this.teardown();
    this.attempt = 0;
    this.open();
  }

  private open(): void {
    if (!this.scope) return;
    this.status.set(this.attempt === 0 ? 'CONNECTING' : 'RECONNECTING');
    this.syncing = true;
    this.buffer = [];
    this.socket = this.transport.connect(this.scope).subscribe({
      next: (e) => this.onEnvelope(e),
      error: () => this.fail(),
    });
    this.snapTimer = setTimeout(() => this.requestSnapshot(), 150);
  }

  private requestSnapshot(): void {
    if (!this.scope) return;
    this.syncing = true;
    this.buffer = [];
    this.status.set('SYNCING');
    this.snapSub?.unsubscribe();
    this.snapSub = this.transport.snapshot(this.scope).subscribe({
      next: (snap) => this.onSnapshot(snap),
      error: () => this.fail(),
    });
  }

  private onSnapshot(snap: Snapshot): void {
    this.clock.sync(snap.ts);
    this.snapshot$.next(snap);
    this.lastSeq = snap.seq;
    this.syncing = false;
    const pending = this.buffer.filter((e) => e.seq > snap.seq).sort((a, b) => a.seq - b.seq);
    this.buffer = [];
    for (const e of pending) {
      if (e.seq !== this.lastSeq + 1) { this.resync(); return; }
      this.lastSeq = e.seq;
      if (e.payload != null) this.bus.next(e);
    }
    this.attempt = 0;
    this.status.set('LIVE');
  }

  private onEnvelope(env: Envelope): void {
    this.lastMessageAt.set(Date.now());
    this.latencyMs.set(Math.max(0, Date.now() - env.ts));
    if (this.status() === 'DEGRADED') this.status.set('LIVE');
    if (this.syncing) { this.buffer.push(env); return; }
    if (env.seq <= this.lastSeq) return;                     // duplicate
    if (env.seq !== this.lastSeq + 1) { this.resync(); return; } // gap → resync
    this.lastSeq = env.seq;
    if (env.payload != null) this.bus.next(env);
  }

  private resync(): void {
    this.resyncCount.update((n) => n + 1);
    this.requestSnapshot();
  }

  private fail(): void {
    this.teardown();
    this.status.set('RECONNECTING');
    const delayMs = Math.min(15_000, 600 * 2 ** this.attempt) + Math.random() * 300;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.open(), delayMs);
  }

  private checkHeartbeat(): void {
    if (this.status() !== 'LIVE' && this.status() !== 'DEGRADED') return;
    const age = Date.now() - this.lastMessageAt();
    if (age > 8000) this.fail();
    else if (age > 3000) this.status.set('DEGRADED');
  }

  private teardown(): void {
    this.socket?.unsubscribe();
    this.snapSub?.unsubscribe();
    this.socket = undefined;
    clearTimeout(this.snapTimer);
    clearTimeout(this.reconnectTimer);
  }
}
