import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, of, switchMap } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { FleetRestApi } from '../../core/backend/fleet-backend';
import { NotificationService } from '../../core/layout/notification.service';
import { Insight, InsightSeverity } from '../../core/models';
import { RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { CommandTrackerStore } from '../overrides/command-tracker.store';

const OPEN_STATES = ['NEW', 'ACKNOWLEDGED', 'ACTION_PROPOSED'];
const SEV_RANK: Record<InsightSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
export const isOpen = (i: Insight) => OPEN_STATES.includes(i.state);

@Injectable({ providedIn: 'root' })
export class InsightsStore {
  private readonly gw = inject(RealtimeGateway);
  private readonly api = inject(FleetRestApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(NotificationService);
  private readonly tracker = inject(CommandTrackerStore);

  readonly entities = signal<Record<string, Insight>>({});
  readonly filter = signal<{ severity: 'ALL' | InsightSeverity }>({ severity: 'ALL' });
  readonly pending = signal<ReadonlySet<string>>(new Set());

  private readonly list = computed(() => Object.values(this.entities()));
  readonly open = computed(() => this.list().filter(isOpen));
  readonly visible = computed(() => {
    const sev = this.filter().severity;
    return this.open()
      .filter((i) => sev === 'ALL' || i.severity === sev)
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.etaMin - b.etaMin || b.confidence - a.confidence);
  });
  readonly pinned = computed(() => this.visible().filter((i) => i.state === 'ACKNOWLEDGED'));
  readonly unpinned = computed(() => this.visible().filter((i) => i.state !== 'ACKNOWLEDGED'));
  readonly recent = computed(() => this.list().filter((i) => !isOpen(i)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5));
  readonly criticalCount = computed(() => this.open().filter((i) => i.severity === 'CRITICAL').length);
  /** Plain-language notices for non-operator audiences. */
  readonly staffNotices = computed(() => this.open().filter((i) => i.severity !== 'INFO' || i.affectedTasks >= 3));

  constructor() {
    this.gw.snapshot$.subscribe((s) => this.entities.set(Object.fromEntries(s.insights.map((i) => [i.id, i]))));
    this.gw.topic$<Insight>('ai.insights').subscribe((ins) => {
      const before = this.entities()[ins.id];
      this.entities.update((cur) => ({ ...cur, [ins.id]: ins }));
      if (before && before.state !== ins.state && this.pending().has(ins.id)) this.setPending(ins.id, false);
      if (!before && ins.severity === 'CRITICAL' && this.auth.can('insight:act')) this.toast.push('critical', ins.title, 6000);
    });
  }

  setFilter(severity: 'ALL' | InsightSeverity): void { this.filter.set({ severity }); }

  /** Apply = REST call; the button stays pending until the stream confirms the lifecycle change (no optimistic success). */
  async apply(i: Insight): Promise<void> {
    if (!i.suggestion || this.pending().has(i.id)) return;
    this.setPending(i.id, true);
    const correlationId = crypto.randomUUID();
    this.tracker.register(correlationId, i.suggestion.command, i.suggestion.label);
    const rec = await firstValueFrom(
      this.api.applyInsight(i.id, correlationId).pipe(
        switchMap(() => this.tracker.awaitTerminal(correlationId, 6000)),
        catchError(() => { this.tracker.fail(correlationId, 'Request failed'); return of(this.tracker.records().find((r) => r.id === correlationId)!); }),
      ),
    );
    if (rec.state === 'DONE') this.toast.push('success', `Applied: ${i.suggestion.label}`);
    else this.toast.push('error', `Could not apply: ${rec.reason ?? 'no acknowledgement'}`);
    setTimeout(() => this.setPending(i.id, false), 1500);
  }

  async acknowledge(i: Insight): Promise<void> { await firstValueFrom(this.api.acknowledgeInsight(i.id)); }
  async dismiss(i: Insight, reason: string): Promise<void> {
    this.setPending(i.id, true);
    await firstValueFrom(this.api.dismissInsight(i.id, reason));
    setTimeout(() => this.setPending(i.id, false), 800);
  }

  private setPending(id: string, on: boolean): void {
    this.pending.update((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  }
}
