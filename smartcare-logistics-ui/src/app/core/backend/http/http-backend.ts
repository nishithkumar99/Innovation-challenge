import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, switchMap } from 'rxjs';
import { webSocket } from 'rxjs/webSocket';
import { AuthService } from '../../auth/auth.service';
import { Intel } from '../../intel.models';
import {
  CommandRequest, Envelope, KpiPoint, KpiWindow, Snapshot, SubscriptionScope, TaskRequest, ValidationResult,
} from '../../models';
import { FleetRestApi, FleetTransport } from '../fleet-backend';
import { RUNTIME } from '../../../runtime-config';

/**
 * REAL adapters for the Java/Spring Boot core (selected with `backend: 'real'` in config.js).
 * Endpoints: see docs/TECHNICAL_DOCUMENTATION.md §7 (REST) and §8 (WebSocket).
 */
export const API_BASE = RUNTIME.apiBase;
export const WS_URL = RUNTIME.wsUrl || (typeof location !== 'undefined' ? location.origin.replace(/^http/, 'ws') : '') + '/ws';

@Injectable()
export class WebSocketTransport extends FleetTransport {
  private readonly http = inject(HttpClient);

  connect(_scope: SubscriptionScope): Observable<Envelope> {
    // Short-lived ticket instead of a long-lived JWT in the URL.
    return this.http.post<{ ticket: string }>(`${API_BASE}/ws/ticket`, {}).pipe(
      switchMap(({ ticket }) => webSocket<Envelope>({ url: `${WS_URL}?ticket=${encodeURIComponent(ticket)}` })),
    );
  }

  snapshot(_scope: SubscriptionScope): Observable<Snapshot> {
    return this.http.get<Snapshot>(`${API_BASE}/fleet/snapshot`);
  }
}

@Injectable()
export class HttpFleetRestApi extends FleetRestApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  createTask(req: TaskRequest, idempotencyKey: string) {
    return this.http.post<{ taskId: string }>(`${API_BASE}/tasks`, req, { headers: { 'Idempotency-Key': idempotencyKey } });
  }
  validateTask(req: TaskRequest) { return this.http.post<ValidationResult>(`${API_BASE}/tasks:validate`, req); }
  sendCommand(cmd: CommandRequest, correlationId: string) {
    const taskCommands = ['REASSIGN', 'CANCEL_TASK', 'SET_PRIORITY'];
    const url = cmd.type.startsWith('FLEET') || cmd.type === 'SET_MODE' ? `${API_BASE}/fleet/commands`
      : cmd.type.endsWith('ZONE') ? `${API_BASE}/zones/${cmd.targetId}/commands`
      : taskCommands.includes(cmd.type) ? `${API_BASE}/tasks/${cmd.targetId}/commands`
      : `${API_BASE}/robots/${cmd.targetId}/commands`;
    return this.http.post<{ correlationId: string }>(url, cmd, {
      headers: { 'Idempotency-Key': correlationId, 'X-Correlation-Id': correlationId, 'X-Actor': this.auth.user().id },
    });
  }
  applyInsight(id: string, correlationId: string) {
    return this.http.post<{ correlationId: string }>(`${API_BASE}/insights/${id}/apply`, {}, { headers: { 'Idempotency-Key': correlationId } });
  }
  dismissInsight(id: string, reason: string) { return this.http.post<void>(`${API_BASE}/insights/${id}/dismiss`, { reason }); }
  acknowledgeInsight(id: string) { return this.http.post<void>(`${API_BASE}/insights/${id}/acknowledge`, {}); }
  getIntel() { return this.http.get<Intel>(`${API_BASE}/intel`); }
  getKpiSeries(window: KpiWindow) { return this.http.get<KpiPoint[]>(`${API_BASE}/kpi/series`, { params: { window } }); }
}
