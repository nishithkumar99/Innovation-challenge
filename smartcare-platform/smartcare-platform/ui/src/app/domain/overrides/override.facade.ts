import { Injectable, inject } from '@angular/core';
import { catchError, firstValueFrom, of, switchMap } from 'rxjs';
import { FleetRestApi } from '../../core/backend/fleet-backend';
import { CommandRequest } from '../../core/models';
import { DialogService } from '../../core/layout/dialog.service';
import { NotificationService } from '../../core/layout/notification.service';
import { RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { CommandRecord, CommandTrackerStore } from './command-tracker.store';

export type Risk = 'low' | 'medium' | 'high' | 'critical';
const ACK_TIMEOUT_MS = 5000;

/**
 * Command → Ack → Effect (blueprint 1.5). Orchestrates confirmation UX by risk level,
 * idempotent REST submission, and correlation of the server acknowledgement.
 */
@Injectable({ providedIn: 'root' })
export class OverrideFacade {
  private readonly api = inject(FleetRestApi);
  private readonly tracker = inject(CommandTrackerStore);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(NotificationService);
  private readonly gw = inject(RealtimeGateway);

  /** Risk-based confirmation, then submit. Resolves to the terminal record, or null if the operator backed out. */
  async run(cmd: CommandRequest, label: string, risk: Risk, message?: string): Promise<CommandRecord | null> {
    if (!this.gw.canControl()) {
      this.toast.push('error', 'Live data is interrupted — command not sent.');
      return null;
    }
    const text = message ?? `${label}?`;
    let reason: string | undefined;
    if (risk === 'low') {
      if (!(await this.dialogs.confirm(label, text))) return null;
    } else {
      if (risk === 'critical' && !(await this.dialogs.ensureStepUp())) {
        this.toast.push('warning', 'Step-up authentication failed or was cancelled.');
        return null;
      }
      const r = await this.dialogs.askReason(label, text, risk === 'critical' ? 'danger' : 'default', label);
      if (!r) return null;
      reason = r;
    }
    return this.submit({ ...cmd, reason: reason ?? cmd.reason }, label);
  }

  /** Submit without confirmation UX (the caller already collected consent). */
  async submit(cmd: CommandRequest, label: string): Promise<CommandRecord | null> {
    const correlationId = crypto.randomUUID();
    this.tracker.register(correlationId, cmd, label);
    const rec = await firstValueFrom(
      this.api.sendCommand(cmd, correlationId).pipe(
        switchMap(() => this.tracker.awaitTerminal(correlationId, ACK_TIMEOUT_MS)),
        catchError(() => { this.tracker.fail(correlationId, 'Request failed'); return of(this.tracker.records().find((r) => r.id === correlationId)!); }),
      ),
    );
    if (rec.state === 'DONE') this.toast.push('success', `${label} — done`);
    else if (rec.state === 'REJECTED') this.toast.push('error', `${label} rejected: ${rec.reason ?? 'unknown reason'}`);
    else this.toast.push('warning', `${label}: status unknown — verify the actual state.`);
    return rec;
  }
}
