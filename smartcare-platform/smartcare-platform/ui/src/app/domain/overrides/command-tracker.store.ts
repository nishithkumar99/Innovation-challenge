import { Injectable, inject, signal } from '@angular/core';
import { Observable, Subject, filter, map, merge, of, take, timer } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { CommandAck, CommandRequest } from '../../core/models';
import { RealtimeGateway } from '../../core/realtime/realtime-gateway';

export type CommandState = 'SENT' | 'ACCEPTED' | 'EXECUTING' | 'DONE' | 'REJECTED' | 'TIMED_OUT';
export interface CommandRecord {
  id: string;
  cmd: CommandRequest;
  label: string;
  state: CommandState;
  reason?: string;
  actor: string;
  at: number;
  updatedAt: number;
}
const RANK: Record<CommandState, number> = { SENT: 0, ACCEPTED: 1, EXECUTING: 2, DONE: 3, REJECTED: 3, TIMED_OUT: 3 };
export const isTerminal = (s: CommandState) => RANK[s] === 3;

/** Correlates `commands.acks` with in-flight REST commands. Never optimistic: state comes from the server. */
@Injectable({ providedIn: 'root' })
export class CommandTrackerStore {
  private readonly auth = inject(AuthService);
  readonly records = signal<CommandRecord[]>([]);
  private readonly updates$ = new Subject<CommandRecord>();

  constructor() {
    inject(RealtimeGateway).topic$<CommandAck>('commands.acks').subscribe((ack) => this.patch(ack.correlationId, ack.state, ack.reason));
  }

  register(id: string, cmd: CommandRequest, label: string): void {
    const now = Date.now();
    const rec: CommandRecord = { id, cmd, label, state: 'SENT', actor: this.auth.user().name, at: now, updatedAt: now };
    this.records.update((r) => [rec, ...r].slice(0, 300));
  }

  fail(id: string, reason: string): void { this.patch(id, 'REJECTED', reason); }

  awaitTerminal(id: string, timeoutMs: number): Observable<CommandRecord> {
    const existing = this.records().find((r) => r.id === id);
    if (existing && isTerminal(existing.state)) return of(existing);
    return merge(
      this.updates$.pipe(filter((r) => r.id === id && isTerminal(r.state))),
      timer(timeoutMs).pipe(map(() => this.patch(id, 'TIMED_OUT', 'No acknowledgement — verify the actual state'))),
    ).pipe(take(1));
  }

  forTarget(targetId: string): CommandRecord[] {
    return this.records().filter((r) => r.cmd.targetId === targetId);
  }

  private patch(id: string, state: CommandState | CommandAck['state'], reason?: string): CommandRecord {
    let out!: CommandRecord;
    this.records.update((all) => all.map((r) => {
      if (r.id !== id) return r;
      const next = RANK[state as CommandState] >= RANK[r.state] ? { ...r, state: state as CommandState, reason: reason ?? r.reason, updatedAt: Date.now() } : r;
      out = next;
      return next;
    }));
    if (out) this.updates$.next(out);
    return out;
  }
}
