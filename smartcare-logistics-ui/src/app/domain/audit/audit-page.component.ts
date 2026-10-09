import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommandTrackerStore } from '../overrides/command-tracker.store';

/** /audit — read-only command log. Production reads the audit API; this view shows the session's correlated commands. */
@Component({
  selector: 'scl-audit-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Audit log</h1><p>Every override and command with actor, reason and outcome. Read-only.</p></div>
        <input type="search" placeholder="Filter by actor, command, target…" aria-label="Filter audit log" [value]="q()" (input)="q.set($any($event.target).value)" />
      </div>
      <div class="banner info">This list shows commands issued in the current session (correlated via acknowledgements). A production deployment reads the backend audit API.</div>
      <div class="card scroll">
        <table class="grid" aria-label="Audit log">
          <thead><tr><th>Time</th><th>Actor</th><th>Command</th><th>Target</th><th>Reason</th><th>Outcome</th></tr></thead>
          <tbody>
            @for (r of rows(); track r.id) {
              <tr>
                <td class="mono">{{ time(r.at) }}</td><td>{{ r.actor }}</td><td>{{ r.label }}</td>
                <td>{{ r.cmd.targetId ?? 'fleet' }}</td><td>{{ r.cmd.reason ?? '—' }}</td>
                <td><span class="chip" [class]="cls(r.state)">{{ icon(r.state) }} {{ r.state.replace('_', ' ') }}</span>@if (r.reason && r.state !== 'DONE') { <small class="faint"> {{ r.reason }}</small> }</td>
              </tr>
            } @empty { <tr><td colspan="6" class="empty">No commands yet.</td></tr> }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: [`.scroll { overflow: auto; max-height: calc(100vh - 17rem); } input { min-width: 18rem; }`],
})
export class AuditPageComponent {
  private readonly tracker = inject(CommandTrackerStore);
  protected readonly q = signal('');
  protected readonly rows = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.tracker.records().filter((r) => !q || `${r.actor} ${r.label} ${r.cmd.targetId ?? ''} ${r.cmd.reason ?? ''}`.toLowerCase().includes(q));
  });
  protected time(ts: number) { return new Date(ts).toLocaleTimeString('de-DE'); }
  protected cls(s: string) { return s === 'DONE' ? 'ok' : s === 'REJECTED' ? 'crit' : s === 'TIMED_OUT' ? 'warn' : 'info'; }
  protected icon(s: string) { return s === 'DONE' ? '✔' : s === 'REJECTED' ? '✖' : s === 'TIMED_OUT' ? '?' : '…'; }
}
