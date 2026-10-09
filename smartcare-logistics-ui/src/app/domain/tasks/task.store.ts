import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { Task } from '../../core/models';
import { RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { PRIORITY_RANK } from '../../shared/util';

const OPEN = ['QUEUED', 'ASSIGNED', 'TO_PICKUP', 'IN_TRANSIT'];

@Injectable({ providedIn: 'root' })
export class TaskStore {
  private readonly gw = inject(RealtimeGateway);
  private readonly auth = inject(AuthService);

  readonly tasks = signal<Record<string, Task>>({});

  readonly all = computed(() => Object.values(this.tasks()).sort((a, b) => b.createdAt - a.createdAt));
  /** Open tasks ordered the way dispatch sees them: priority, then age. */
  readonly open = computed(() =>
    this.all().filter((t) => OPEN.includes(t.status)).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt));
  readonly mine = computed(() => this.all().filter((t) => t.requester === this.auth.user().id));
  readonly queuedCount = computed(() => this.all().filter((t) => t.status === 'QUEUED').length);
  readonly simulatedOpen = computed(() => this.open().filter((t) => t.origin === 'SIMULATED').length);

  constructor() {
    this.gw.snapshot$.subscribe((s) => this.tasks.set(Object.fromEntries(s.tasks.map((t) => [t.id, t]))));
    this.gw.topic$<Task[]>('tasks.events').subscribe((batch) => {
      if (!batch.length) return;
      this.tasks.update((cur) => {
        const next = { ...cur };
        for (const t of batch) if (!cur[t.id] || t.version >= cur[t.id].version) next[t.id] = t; // out-of-order guard
        return next;
      });
    });
  }

  byId(id: string | null | undefined): Task | undefined { return id ? this.tasks()[id] : undefined; }
  forRobot(robotId: string): Task | undefined { return this.open().find((t) => t.robotId === robotId); }
}
