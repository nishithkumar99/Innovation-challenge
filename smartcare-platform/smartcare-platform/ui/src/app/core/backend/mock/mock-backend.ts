import { Injectable, inject } from '@angular/core';
import { Observable, delay, map, of, timer, switchMap } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { Intel } from '../../intel.models';
import {
  CommandRequest, Envelope, KpiPoint, KpiWindow, Robot, Snapshot, SubscriptionScope, TaskRequest, ValidationResult, ZonesPayload,
} from '../../models';
import { FleetRestApi, FleetTransport } from '../fleet-backend';
import { MockFleetServer } from './mock-fleet-server';

const LATENCY = 120;

/** Fake WebSocket: subscribe = open, error = socket dropped. Applies per-scope topic filtering like a real server would. */
@Injectable()
export class MockTransport extends FleetTransport {
  private readonly server = inject(MockFleetServer);

  connect(scope: SubscriptionScope): Observable<Envelope> {
    this.server.start();
    const ops = this.server.isOps(scope);
    return timer(60).pipe(
      switchMap(() => new Observable<Envelope>((sub) => {
        const msgs = this.server.messages$.subscribe((env) => {
          const filtered = this.filter(env, scope, ops);
          if (filtered) sub.next(filtered);
        });
        const drop = this.server.drop$.subscribe(() => sub.error(new Error('socket closed')));
        return () => { msgs.unsubscribe(); drop.unsubscribe(); };
      })),
    );
  }

  snapshot(scope: SubscriptionScope): Observable<Snapshot> {
    this.server.start();
    return of(null).pipe(delay(LATENCY * 2), map(() => this.server.snapshot(scope)));
  }

  private filter(env: Envelope, scope: SubscriptionScope, ops: boolean): Envelope | null {
    if (ops) return env;
    switch (env.topic) {
      case 'fleet.robots': {
        // Staff only ever see the robot working on one of their own requests.
        const allowed = new Set(this.server.robotsFor(scope).map((s) => s.robot.id));
        const payload = (env.payload as Robot[]).filter((r) => allowed.has(r.id));
        return payload.length ? { ...env, payload } : { ...env, payload: [] };
      }
      case 'tasks.events': {
        const payload = (env.payload as { requester: string }[]).filter((t) => t.requester === scope.userId);
        return { ...env, payload };
      }
      case 'fleet.zones': return { ...env, payload: { zones: [], stations: (env.payload as ZonesPayload).stations } };
      case 'ai.insights': case 'system.status': return env;
      default: return { ...env, payload: null }; // keep seq continuity; payload withheld
    }
  }
}

@Injectable()
export class MockRestApi extends FleetRestApi {
  private readonly server = inject(MockFleetServer);
  private readonly auth = inject(AuthService);

  createTask(req: TaskRequest, _idempotencyKey: string): Observable<{ taskId: string }> {
    const u = this.auth.user();
    return of(null).pipe(delay(LATENCY), map(() => this.server.createTask(req, { id: u.id, name: u.name })));
  }
  validateTask(req: TaskRequest): Observable<ValidationResult> {
    return of(null).pipe(delay(LATENCY), map(() => this.server.validateTask(req)));
  }
  sendCommand(cmd: CommandRequest, correlationId: string): Observable<{ correlationId: string }> {
    return of(null).pipe(delay(LATENCY), map(() => { this.server.command(cmd, correlationId); return { correlationId }; }));
  }
  applyInsight(insightId: string, correlationId: string): Observable<{ correlationId: string }> {
    return of(null).pipe(delay(LATENCY), map(() => { this.server.applyInsight(insightId, correlationId); return { correlationId }; }));
  }
  dismissInsight(insightId: string): Observable<void> {
    return of(null).pipe(delay(LATENCY), map(() => this.server.dismissInsight(insightId)));
  }
  acknowledgeInsight(insightId: string): Observable<void> {
    return of(null).pipe(delay(LATENCY), map(() => this.server.acknowledgeInsight(insightId)));
  }
  getIntel(): Observable<Intel> {
    this.server.start();
    return of(null).pipe(delay(LATENCY), map(() => this.server.intel()));
  }
  getKpiSeries(window: KpiWindow): Observable<KpiPoint[]> {
    this.server.start();
    return of(null).pipe(delay(LATENCY), map(() => this.server.kpiSeries(window)));
  }
}

/** Developer menu helpers for exercising failure modes (only wired when IS_MOCK_BACKEND is true). */
@Injectable({ providedIn: 'root' })
export class MockControls {
  private readonly server = inject(MockFleetServer);
  dropConnection() { this.server.dropConnections(); }
  forceGap() { this.server.forceSequenceGap(); }
  muteRobot(id: string, muted: boolean) { this.server.muteRobot(id, muted); }
  injectFault(id: string) { this.server.injectFault(id); }
  setAi(available: boolean) { this.server.setAiAvailable(available); }
  robotIds() { return this.server.robotIds(); }
  scenario(name: 'rush' | 'corridor' | 'fault' | 'calm'): string { return this.server.runScenario(name); }
}
