import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { Intel } from '../intel.models';
import {
  CommandRequest, Envelope, KpiPoint, KpiWindow, Snapshot, SubscriptionScope, TaskRequest, ValidationResult,
} from '../models';

/**
 * Read path. `connect()` is cold: subscribing opens the socket, unsubscribing closes it,
 * an error means the connection dropped (the gateway handles reconnect + resync).
 */
export abstract class FleetTransport {
  abstract connect(scope: SubscriptionScope): Observable<Envelope>;
  abstract snapshot(scope: SubscriptionScope): Observable<Snapshot>;
}

/** Write path (commands) and query path (KPI). All writes are async: terminal state arrives on the stream. */
export abstract class FleetRestApi {
  abstract createTask(req: TaskRequest, idempotencyKey: string): Observable<{ taskId: string }>;
  abstract validateTask(req: TaskRequest): Observable<ValidationResult>;
  abstract sendCommand(cmd: CommandRequest, correlationId: string): Observable<{ correlationId: string }>;
  abstract applyInsight(insightId: string, correlationId: string): Observable<{ correlationId: string }>;
  abstract dismissInsight(insightId: string, reason: string): Observable<void>;
  abstract acknowledgeInsight(insightId: string): Observable<void>;
  abstract getKpiSeries(window: KpiWindow): Observable<KpiPoint[]>;
  /** Explanations of the AI decisions (dispatch, energy, traffic, anomalies) for the AI Control page. */
  abstract getIntel(): Observable<Intel>;
}

/** True when the in-browser mock backend is wired (shows the mock-control menu in the status bar). */
export const IS_MOCK_BACKEND = new InjectionToken<boolean>('IS_MOCK_BACKEND', { factory: () => false });
