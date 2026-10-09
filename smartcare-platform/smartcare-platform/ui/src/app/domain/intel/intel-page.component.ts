import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HasPermissionDirective } from '../../core/auth/permission.directive';
import { Intel, IntelEnergyRobot, IntelQueueItem } from '../../core/intel.models';
import { RealtimeGateway } from '../../core/realtime/realtime-gateway';
import { ChartComponent, ChartSeries } from '../../shared/ui/chart.component';
import { ROBOT_STATUS_COLOR, ROBOT_STATUS_ICON, ROBOT_STATUS_LABEL } from '../../shared/util';
import { OverrideFacade } from '../overrides/override.facade';
import { IntelStore } from './intel.store';

type Tab = 'dispatch' | 'energy' | 'traffic' | 'anomalies' | 'forecast';
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'dispatch', icon: '⇄', label: 'Task distribution' },
  { id: 'energy', icon: '⚡', label: 'Energy' },
  { id: 'traffic', icon: '⛕', label: 'Process control' },
  { id: 'anomalies', icon: '◬', label: 'Anomalies' },
  { id: 'forecast', icon: '✧', label: 'AI forecast' },
];
const LEVEL_COLOR = { CRITICAL: 'var(--crit)', LOW: 'var(--warn)', OK: 'var(--ok)', FULL: 'var(--accent)' } as const;
const PRIO_COLOR = { STAT: 'var(--crit)', URGENT: 'var(--warn)', ROUTINE: 'var(--info)' } as const;
const secs = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

/**
 * /ai — "AI Control": shows WHAT the AI layer of the core decided and WHY, for the four focus areas
 * (task distribution, energy management, process control, anomaly detection).
 */
@Component({
  selector: 'scl-intel-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartComponent, RouterLink, HasPermissionDirective],
  providers: [IntelStore],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>AI Control</h1>
          <p>See what the AI decides — and why. Updates every 2 seconds.</p>
        </div>
        <span class="chip" [class]="store.error() ? 'warn' : 'ok'">{{ store.error() ? '▲ ' + store.error() : '● Live' }}</span>
      </div>

      @if (d(); as d) {
        <!-- ───────── summary tiles = tabs ───────── -->
        <div class="tiles" role="tablist" aria-label="Focus areas">
          @for (t of tabs; track t.id) {
            <button type="button" role="tab" class="tile" [class.active]="tab() === t.id" [attr.aria-selected]="tab() === t.id" (click)="tab.set(t.id)">
              <span class="ico">{{ t.icon }}</span>
              <span class="tt">{{ t.label }}</span>
              @switch (t.id) {
                @case ('dispatch') {
                  <strong>{{ d.dispatch.queueLength }} waiting</strong>
                  <small>Fair-share score {{ d.dispatch.balanceIndex }} / 100 · {{ d.dispatch.utilisationPct }} % busy</small>
                }
                @case ('energy') {
                  <strong>{{ d.energy.availableNow }} of {{ d.energy.fleetSize }} ready</strong>
                  <small>{{ d.energy.charging }} charging · {{ d.energy.lowBattery }} low · avg {{ d.energy.avgBattery }} %</small>
                }
                @case ('traffic') {
                  <strong [class.bad]="d.traffic.deadlocks.length">{{ d.traffic.deadlocks.length ? d.traffic.deadlocks.length + ' deadlock' : d.traffic.waitingRobots + ' waiting' }}</strong>
                  <small>{{ d.traffic.activeMissions }} robots driving · {{ d.traffic.deadlocksResolved }} jams solved</small>
                }
                @case ('anomalies') {
                  <strong [class.bad]="firing(d) > 0">{{ firing(d) ? firing(d) + ' firing' : 'All clear' }}</strong>
                  <small>{{ watching(d) }} watched · {{ d.anomalies.detectors.length }} detectors</small>
                }
                @case ('forecast') {
                  <strong [class.bad]="d.forecast.demandLevel === 'HIGH'">{{ levelShort(d.forecast.demandLevel) }}</strong>
                  <small>{{ d.forecast.ready ? '≈ ' + d.forecast.expected10 + ' orders in 10 min' : 'learning ' + d.forecast.trainedBuckets + '/' + d.forecast.minBuckets }}</small>
                }
              }
            </button>
          }
        </div>

        @switch (tab()) {
          <!-- ═════════════ 1. TASK DISTRIBUTION ═════════════ -->
          @case ('dispatch') {
            <p class="explain">
              <b>How it works:</b> every waiting order gets <b>priority points</b> (STAT 100 · URGENT 50 · ROUTINE 20) plus <b>+{{ d.dispatch.weights['agingPerMin'] }} per minute</b> of waiting (max +{{ d.dispatch.weights['agingCap'] }}),
              so nothing waits forever. For each order the AI scores every robot by travel time, recent workload, battery and traffic, then picks the best overall
              combination ({{ d.dispatch.algorithm }}). Mode: <b>{{ d.dispatch.mode === 'AUTO' ? 'automatic' : 'semi-automatic' }}</b>.
            </p>
            <div class="grid2">
              <section class="card pad">
                <h3 class="panel-title">1 · Priority queue &amp; best vehicle</h3>
                @for (q of d.dispatch.queue; track q.id) {
                  <article class="q" [class.open]="openTask() === q.id">
                    <button type="button" class="qhead" (click)="openTask.set(openTask() === q.id ? '' : q.id)" [attr.aria-expanded]="openTask() === q.id">
                      <span class="chip" [style.--c]="prio(q.priority)">{{ q.priority }}</span>
                      <span class="qroute"><span class="rt"><b>{{ q.fromName }}</b> → <b>{{ q.toName }}</b></span><small>{{ q.item }} · {{ q.id }}</small></span>
                      <span class="pts" [title]="q.basePoints + ' base + ' + q.agingPoints + ' aging'">
                        <span class="pbar"><i class="base" [style.width.%]="pct(q.basePoints)"></i><i class="age" [style.width.%]="pct(q.agingPoints)"></i></span>
                        <small>{{ q.points }} pts · waiting {{ fmt(q.ageSec) }}</small>
                      </span>
                      <span class="best">
                        @if (best(q); as b) { ✔ {{ b.robot }}<small>{{ b.etaToPickupSec ?? '—' }} s away</small> }
                        @else { <span class="muted">no robot free</span> }
                      </span>
                    </button>
                    @if (openTask() === q.id) {
                      <table class="grid cand" aria-label="Vehicle ranking">
                        <thead><tr><th>#</th><th>Vehicle</th><th>To pickup</th><th>Battery</th><th>Recent jobs</th><th>Score (lower = better)</th></tr></thead>
                        <tbody>
                          @for (c of q.candidates; track c.robot; let i = $index) {
                            <tr [class.dim]="!c.eligible" [class.win]="i === 0 && c.eligible">
                              <td>{{ c.eligible ? i + 1 : '—' }}</td><td><b>{{ c.robot }}</b></td>
                              <td>{{ c.etaToPickupSec ?? '—' }} s</td><td>{{ c.battery }} %</td><td>{{ c.recentTasks }}</td>
                              <td>@if (c.eligible) { {{ c.cost }} } @else { <span class="faint">✕ {{ c.reason }}</span> }</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    }
                  </article>
                } @empty { <div class="empty">✔ No order is waiting — every request already has a robot.</div> }
                @if (d.dispatch.queueLength > d.dispatch.queue.length) { <p class="hint">+ {{ d.dispatch.queueLength - d.dispatch.queue.length }} more waiting</p> }
              </section>

              <section class="card pad">
                <h3 class="panel-title">2 · Real-time load balancing</h3>
                <p class="hint">Jobs completed per robot in the last {{ d.dispatch.weights['recentWindowS'] / 60 }} min. The AI adds a penalty for busy robots so work is shared evenly.</p>
                <div class="gauge-row">
                  <div class="ring" [style.--p]="d.dispatch.balanceIndex" [class.warn]="d.dispatch.balanceIndex < 60"><b>{{ d.dispatch.balanceIndex }}</b><small>fair share</small></div>
                  <div class="grow">
                    @for (l of d.dispatch.load; track l.robot) {
                      <div class="lrow">
                        <span class="lname">{{ l.robot }}</span>
                        <span class="pbar slim"><i class="base" [style.width.%]="loadPct(l.recentTasks)"></i></span>
                        <span class="lnum">{{ l.recentTasks }}</span>
                        <span class="chip" [style.--c]="stColor(l.status)">{{ stIcon(l.status) }} {{ stLabel(l.status) }}</span>
                      </div>
                    }
                  </div>
                </div>
                <h4 class="sub">Latest assignments</h4>
                @for (x of d.dispatch.lastDecision; track $index) { <div class="mono small">{{ x }}</div> } @empty { <div class="faint small">None yet.</div> }
              </section>
            </div>
          }

          <!-- ═════════════ 2. ENERGY ═════════════ -->
          @case ('energy') {
            <p class="explain">
              <b>Rules the AI follows:</b> below <b>{{ d.energy.policy.critical }} %</b> a robot gets no new work · below <b>{{ d.energy.policy.low }} %</b> it drives to a charger as soon as it is idle ·
              below <b>{{ d.energy.policy.opportunisticBelow }} %</b> it tops up when no order is waiting · charging stops at <b>{{ d.energy.policy.target }} %</b>
              (or at {{ d.energy.policy.minRelease }} % when orders are waiting). Consumption learned from real trips: <b>{{ d.energy.learnedPctPerMeter }} % per metre</b>.
            </p>
            <div class="kpis">
              <div class="card kpi"><small>Vehicle availability</small><strong>{{ d.energy.availabilityPct }} %</strong><span class="pbar slim"><i class="ok" [style.width.%]="d.energy.availabilityPct"></i></span></div>
              <div class="card kpi"><small>Ready now</small><strong>{{ d.energy.availableNow }} / {{ d.energy.fleetSize }}</strong></div>
              <div class="card kpi"><small>Charging</small><strong>{{ d.energy.charging }}</strong></div>
              <div class="card kpi"><small>Low battery</small><strong [class.bad]="d.energy.lowBattery">{{ d.energy.lowBattery }}</strong></div>
              <div class="card kpi"><small>Charging stops (auto)</small><strong>{{ d.energy.chargeStops }}</strong></div>
            </div>
            <div class="grid2">
              <section class="card pad">
                <h3 class="panel-title">1 · Battery status of each robot</h3>
                @for (r of d.energy.robots; track r.robot) {
                  <div class="brow">
                    <div class="bhead"><b>{{ r.robot }}</b>
                      <span class="chip" [style.--c]="lvl(r)">{{ r.charging ? '⚡ ' : '' }}{{ r.level }}</span>
                      <span class="grow"></span><span class="bpct">{{ r.battery }} %</span></div>
                    <div class="bbar" [attr.aria-label]="r.robot + ' battery ' + r.battery + ' percent'">
                      <i [style.width.%]="r.battery" [style.background]="lvl(r)"></i>
                      <u [style.left.%]="d.energy.policy.critical" title="critical"></u><u [style.left.%]="d.energy.policy.low" title="low"></u>
                      <u [style.left.%]="d.energy.policy.target" title="charge target"></u>
                    </div>
                    <div class="bnote"><span>{{ r.action }}</span><span class="faint">range ≈ {{ r.rangeM }} m</span></div>
                  </div>
                }
                <p class="hint legend">Marks on the bar: critical {{ d.energy.policy.critical }} % · low {{ d.energy.policy.low }} % · target {{ d.energy.policy.target }} %</p>
              </section>
              <div class="col">
                <section class="card pad">
                  <h3 class="panel-title">2 · Automatic charging</h3>
                  @for (c of d.energy.chargers; track c.id) {
                    <div class="charger">
                      <b>{{ c.name }}</b>
                      <div class="slots">
                        @for (s of slots(c.capacity); track s) {
                          <span class="slot" [class.used]="s < c.occupied" [title]="slotName(c.robots, s)">{{ slotName(c.robots, s) }}</span>
                        }
                      </div>
                      @if (c.incoming.length) { <small class="muted">on the way: {{ c.incoming.join(', ') }}</small> }
                    </div>
                  } @empty { <div class="empty">No charging station on the map.</div> }
                </section>
                <scl-chart title="3 · Vehicle availability (blue) &amp; average battery (orange) — last minutes" type="line" [series]="energySeries()" [xs]="energyXs()" [height]="170"
                           [fmt]="pctFmt" />
              </div>
            </div>
          }

          <!-- ═════════════ 3. PROCESS CONTROL ═════════════ -->
          @case ('traffic') {
            <p class="explain">
              <b>How it works:</b> a robot only receives the next <b>{{ d.traffic.policy.lookaheadSegments }} segments</b> of its route once the core has reserved them (one robot per corridor, limited slots at stations).
              If robots wait for each other in a circle (<b>deadlock</b>, after {{ d.traffic.policy.deadlockMinWaitS }} s) the AI re-routes the least important one{{ d.traffic.policy.autoResolve ? '' : ' — currently only after operator approval' }}.
              Routes use <b>learned travel times</b> and avoid busy, blocked and restricted areas.
            </p>
            <div class="grid2">
              <section class="card pad">
                <h3 class="panel-title">1 · Coordination of all robots</h3>
                <div class="scroll"><table class="grid" aria-label="Robot coordination">
                  <thead><tr><th>Robot</th><th>Status</th><th>Heading to</th><th>Route</th><th>Waiting</th></tr></thead>
                  <tbody>
                    @for (r of d.traffic.robots; track r.robot) {
                      <tr>
                        <td><b>{{ r.robot }}</b></td>
                        <td><span class="chip" [style.--c]="stColor(r.status)">{{ stIcon(r.status) }} {{ stLabel(r.status) }}</span></td>
                        <td>{{ r.heading ?? '—' }}<small class="faint block">{{ r.taskId ?? (r.mission === 'CHARGE' ? 'charging trip' : '') }}</small></td>
                        <td>@if (r.mission) { <span class="seg-dots" [title]="r.released + ' segments released, ' + r.remaining + ' to go'">
                            @for (i of dots(r.remaining); track i) { <i [class.rel]="i < r.released"></i> }</span> } @else { — }</td>
                        <td>@if (r.waitingFor) { <span class="chip warn">⏸ {{ r.waitNode ?? '' }} {{ r.waitSec ? '· ' + r.waitSec + ' s' : '' }}</span> } @else { <span class="faint">flowing</span> }</td>
                      </tr>
                    }
                  </tbody></table></div>
              </section>

              <div class="col">
                <section class="card pad">
                  <h3 class="panel-title">2 · Deadlocks &amp; traffic jams</h3>
                  @for (x of d.traffic.deadlocks; track $index) {
                    <div class="banner danger"><span>⚠ Deadlock: {{ x.robots.join(' ↔ ') }} — <b>{{ x.resolution }}</b> <span class="faint">({{ x.ageSec }} s)</span></span></div>
                  } @empty { <div class="banner ok"><span>✔ No deadlock. {{ d.traffic.deadlocksResolved }} resolved automatically so far.</span></div> }
                  @for (b of d.traffic.bottlenecks; track b.node) {
                    <div class="banner warn"><span>⏸ Bottleneck at <b>{{ b.name }}</b>: {{ b.waiting.join(', ') }} waiting</span></div>
                  } @empty { <div class="hint">No bottleneck right now.</div> }
                </section>
                <section class="card pad">
                  <h3 class="panel-title">3 · Restricted &amp; closed areas</h3>
                  @for (z of d.traffic.zones; track z.id) {
                    <div class="zrow"><span class="chip" [class]="z.restricted ? 'crit' : 'info'">{{ z.restricted ? '⛔ restricted' : 'zone' }}</span><b>{{ z.name }}</b><small class="faint">{{ z.nodeNames.join(', ') }}</small></div>
                  } @empty { <div class="hint">No restricted zone is defined in the map file (<span class="mono">zones[].restricted = true</span> excludes an area from routing).</div> }
                  @for (b of d.traffic.blockedEdges; track b.id) {
                    <div class="zrow"><span class="chip warn">⛔ closed</span><b>{{ b.from }} ↔ {{ b.to }}</b>
                      <span class="grow"></span>
                      <button *sclHasPermission="'override:fleet'" class="btn sm" type="button" [disabled]="!gw.canControl()" (click)="reopen(b.id, b.from + ' ↔ ' + b.to)">Reopen</button></div>
                  } @empty { <div class="hint">No corridor is closed. <a routerLink="/ops">Close one in the control center</a> if needed — robots re-route around it.</div> }
                </section>
              </div>
            </div>

            <div class="grid2">
              <section class="card pad">
                <h3 class="panel-title">4 · Travel-time optimisation</h3>
                <p class="hint">Routes are planned with the <b>learned</b> time per corridor. Network is <b>{{ d.traffic.networkSlowdownPct }} %</b> slower than free flow.</p>
                @for (c of d.traffic.slowCorridors; track c.id) {
                  <div class="crow"><span>{{ c.from }} ↔ {{ c.to }}</span><span class="pbar slim"><i [class]="c.slowdownPct > 50 ? 'bad' : 'warnb'" [style.width.%]="min(c.slowdownPct, 100)"></i></span>
                    <small>{{ c.freeSec }} s → <b>{{ c.learnedSec }} s</b> (+{{ c.slowdownPct }} %)</small></div>
                } @empty { <div class="empty">✔ All corridors run at normal speed.</div> }
              </section>
              <section class="card pad">
                <h3 class="panel-title">5 · Forecast: where it will get busy</h3>
                @for (f of d.traffic.forecast; track $index) {
                  <div class="crow"><span class="chip info">+{{ f.horizonMin }} min</span><span>{{ f.from }} ↔ {{ f.to }}</span>
                    <span class="pbar slim"><i [class]="f.severity > 0.85 ? 'bad' : 'warnb'" [style.width.%]="f.severity * 100"></i></span><small>{{ (f.confidence * 100).toFixed(0) }} % sure</small></div>
                } @empty { <div class="empty">✔ No congestion expected in the next 30 minutes.</div> }
              </section>
            </div>
            <scl-chart title="Robots waiting (blue) &amp; congestion index % (orange) — last minutes" type="line" [series]="trafficSeries()" [xs]="trafficXs()" [height]="160" [fmt]="intFmt" />
          }

          <!-- ═════════════ 5. AI FORECAST ═════════════ -->
          @case ('forecast') {
            <p class="explain">
              <b>The AI model:</b> an online-learning demand forecaster. For every pickup station it learns how many orders arrive per {{ d.forecast.bucketSeconds }} s —
              from <b>recent arrivals</b> (reacts in minutes) and a <b>daily profile</b> (learns rush hours over days). It needs no external service and keeps learning while the system runs.
              The core uses the forecast to <b>park idle robots where orders will appear</b>, to <b>keep robots available</b> instead of topping up when a rush is expected,
              and to <b>release charging robots early</b>.
            </p>
            <div class="kpis">
              <div class="card kpi"><small>Expected demand</small><strong [class.bad]="d.forecast.demandLevel === 'HIGH'">{{ levelLabel(d.forecast.demandLevel) }}</strong></div>
              <div class="card kpi"><small>Orders in next 10 min</small><strong>{{ d.forecast.ready ? '≈ ' + d.forecast.expected10 : '—' }}</strong></div>
              <div class="card kpi"><small>Orders in next 30 min</small><strong>{{ d.forecast.ready ? '≈ ' + d.forecast.expected30 : '—' }}</strong></div>
              <div class="card kpi"><small>Model error (per {{ d.forecast.bucketSeconds }} s)</small><strong>{{ d.forecast.trainedBuckets > 1 ? '± ' + d.forecast.mae : '—' }}</strong>
                <small class="muted">{{ d.forecast.trainedBuckets > 1 ? 'naive guess ± ' + d.forecast.naiveMae + (d.forecast.improvementPct > 0 ? ' · ' + d.forecast.improvementPct + ' % better' : '') : 'collecting data' }}</small></div>
              <div class="card kpi"><small>Learning progress</small><strong>{{ d.forecast.ready ? 'Active' : d.forecast.trainedBuckets + ' / ' + d.forecast.minBuckets }}</strong>
                <span class="pbar slim"><i class="ok" [style.width.%]="min(100 * d.forecast.trainedBuckets / d.forecast.minBuckets, 100)"></i></span></div>
            </div>
            <div class="grid2">
              <section class="card pad">
                <h3 class="panel-title">1 · Where orders are expected (next 10 / 30 min)</h3>
                @for (s of d.forecast.stations; track s.id) {
                  <div class="crow"><b class="sname">{{ s.name }}</b>
                    <span class="pbar slim"><i class="base" [style.width.%]="min(100 * s.expected10 / maxStation(d), 100)"></i></span>
                    <small>≈ <b>{{ s.expected10 }}</b> / {{ s.expected30 }}</small>
                    @if (s.robots.length) { <span class="chip ok">▣ {{ s.robots.join(', ') }} waiting</span> }
                  </div>
                } @empty { <div class="empty">No orders seen yet — the model starts learning with the first request.</div> }
              </section>
              <section class="card pad">
                <h3 class="panel-title">2 · What the AI did with the forecast</h3>
                <div class="wrap-gap">
                  <span class="chip info">📍 {{ d.forecast.counters['PRE_POSITION'] ?? 0 }} robots pre-positioned</span>
                  <span class="chip ok">✔ {{ d.forecast.counters['KEPT_READY'] ?? 0 }} kept ready</span>
                  <span class="chip neutral">⚡ {{ d.forecast.counters['RELEASED_EARLY'] ?? 0 }} released early</span>
                </div>
                @for (x of d.forecast.decisions; track $index) {
                  <div class="find"><span class="chip" [class]="x.type === 'PRE_POSITION' ? 'info' : x.type === 'KEPT_READY' ? 'ok' : 'neutral'">{{ decLabel(x.type) }}</span>
                    <span class="grow">{{ x.text }}</span><small class="faint">{{ fmt(x.ageSec) }} ago</small></div>
                } @empty { <div class="empty">No forecast-driven action yet. {{ d.forecast.ready ? 'Waiting for a situation where it helps.' : 'The model is still learning.' }}</div> }
              </section>
            </div>
            <scl-chart title="Orders per {{ d.forecast.bucketSeconds }} s: actual (blue) vs predicted by the model (orange)" type="line" [series]="forecastSeries()" [xs]="forecastXs()" [height]="170" [fmt]="oneFmt" />
          }

          <!-- ═════════════ 4. ANOMALIES ═════════════ -->
          @case ('anomalies') {
            <p class="explain">
              <b>Six watchers</b> run every second. A watcher turns <b>amber</b> when it reaches 70 % of its limit and <b>red</b> when it fires; every finding appears in the
              <a routerLink="/ops">control center</a> with a suggested action.
            </p>
            <div class="dets">
              @for (x of d.anomalies.detectors; track x.id) {
                <article class="card det" [class]="x.state.toLowerCase()">
                  <header><span class="chip" [style.--c]="detColor(x.state)">{{ x.state === 'FIRING' ? '⚠ FIRING' : x.state === 'WATCH' ? '◔ WATCH' : '✔ OK' }}</span>
                    @if (x.active) { <span class="chip crit">{{ x.active }} active</span> }</header>
                  <h3>{{ x.title }}</h3>
                  <p>{{ x.description }}</p>
                  @if (x.limit > 0) {
                    <div class="pbar slim"><i [style.width.%]="min(100 * x.current / x.limit, 100)" [style.background]="detColor(x.state)"></i></div>
                    <small class="muted">now {{ x.current }}{{ x.unit && x.unit !== 'z' ? ' ' + x.unit : '' }} · limit {{ x.limit }}{{ x.unit && x.unit !== 'z' ? ' ' + x.unit : '' }}</small>
                  }
                  <small class="faint rule">Rule: {{ x.rule }}</small>
                </article>
              }
            </div>
            <section class="card pad">
              <h3 class="panel-title">Recent findings</h3>
              @for (i of d.anomalies.recent; track i.id) {
                <div class="find">
                  <span class="chip" [class]="i.severity === 'CRITICAL' ? 'crit' : i.severity === 'WARNING' ? 'warn' : 'info'">{{ i.severity }}</span>
                  <span class="grow"><b>{{ i.title }}</b>@if (i.message) { <small class="muted block">{{ i.message }}</small> }</span>
                  <span class="chip neutral">{{ i.state.replace('_', ' ').toLowerCase() }}</span><small class="faint">{{ fmt(i.ageSec) }} ago</small>
                </div>
              } @empty { <div class="empty">✔ Nothing unusual detected.</div> }
            </section>
          }
        }
      } @else if (store.loading()) {
        <div class="card pad empty">Loading AI decisions…</div>
      } @else {
        <div class="banner warn">{{ store.error() }}</div>
      }
    </div>
  `,
  styles: [`
    .tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .75rem; }
    .sname { min-width: 8rem; }
    .tile { text-align: left; font: inherit; color: var(--text); cursor: pointer; background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
      padding: .8rem 1rem; display: grid; grid-template-columns: auto 1fr; column-gap: .75rem; row-gap: .1rem; align-items: center; transition: transform .12s, border-color .12s, background .12s; }
    .tile:hover { transform: translateY(-1px); border-color: var(--accent); }
    .tile.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); box-shadow: 0 0 0 1px var(--accent) inset; }
    .tile .ico { grid-row: span 3; width: 2.4rem; height: 2.4rem; border-radius: 12px; display: grid; place-items: center; font-size: 1.2rem;
      background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
    .tile .tt { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); font-weight: 700; }
    .tile strong { font-size: 1.15rem; } .tile small { color: var(--text-dim); }
    .bad { color: var(--crit); }
    .explain { margin: 0; padding: .7rem 1rem; border-radius: 12px; background: color-mix(in srgb, var(--info) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--info) 35%, var(--border)); color: var(--text); line-height: 1.55; }
    .pad { padding: 1rem; display: flex; flex-direction: column; gap: .6rem; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
    .col { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
    .grow { flex: 1; min-width: 0; } .block { display: block; } .small { font-size: .78rem; }
    .sub { margin: .4rem 0 0; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); }
    .scroll { overflow: auto; }

    .q { border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); }
    .q.open { border-color: var(--accent); }
    .qhead { all: unset; box-sizing: border-box; width: 100%; cursor: pointer; display: grid; grid-template-columns: auto minmax(11rem, 1.3fr) minmax(0, 1fr) auto; gap: .75rem; align-items: center; padding: .6rem .8rem; }
    .qhead:focus-visible { outline: 2px solid var(--accent); border-radius: 12px; }
    .qroute { display: flex; flex-direction: column; min-width: 0; } .rt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .qroute small, .pts small, .best small { color: var(--text-dim); font-size: .72rem; }
    .pts { display: flex; flex-direction: column; gap: .2rem; } .best { display: flex; flex-direction: column; text-align: right; font-weight: 700; color: var(--ok); }
    .pbar { display: flex; height: .55rem; border-radius: 999px; background: color-mix(in srgb, var(--text-faint) 22%, transparent); overflow: hidden; }
    .pbar.slim { height: .4rem; min-width: 4rem; }
    .pbar i { display: block; height: 100%; } .pbar .base { background: var(--accent); } .pbar .age { background: var(--warn); } .pbar .ok { background: var(--ok); }
    .pbar .bad { background: var(--crit); } .pbar .warnb { background: var(--warn); }
    table.cand { margin: 0 .5rem .6rem; width: calc(100% - 1rem); }
    tr.dim td { color: var(--text-faint); } tr.win td { background: color-mix(in srgb, var(--ok) 14%, transparent); font-weight: 600; }

    .gauge-row { display: flex; gap: 1rem; align-items: center; }
    .ring { --p: 100; width: 5.6rem; height: 5.6rem; border-radius: 50%; display: grid; place-content: center; text-align: center; flex: none;
      background: radial-gradient(closest-side, var(--surface) 76%, transparent 78%), conic-gradient(var(--ok) calc(var(--p) * 1%), color-mix(in srgb, var(--text-faint) 25%, transparent) 0); }
    .ring.warn { background: radial-gradient(closest-side, var(--surface) 76%, transparent 78%), conic-gradient(var(--warn) calc(var(--p) * 1%), color-mix(in srgb, var(--text-faint) 25%, transparent) 0); }
    .ring b { font-size: 1.4rem; line-height: 1; } .ring small { font-size: .62rem; color: var(--text-dim); }
    .lrow { display: grid; grid-template-columns: 4.2rem minmax(3rem, 1fr) 1.4rem auto; gap: .5rem; align-items: center; padding: .15rem 0; }
    .lname { font-weight: 700; } .lnum { text-align: right; font-weight: 700; }

    .kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .75rem; }
    .kpi { padding: .7rem .9rem; display: flex; flex-direction: column; gap: .2rem; } .kpi small { color: var(--text-dim); } .kpi strong { font-size: 1.4rem; }
    .brow { display: flex; flex-direction: column; gap: .25rem; padding: .35rem 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
    .bhead { display: flex; align-items: center; gap: .5rem; } .bpct { font-weight: 800; }
    .bbar { position: relative; height: .75rem; background: color-mix(in srgb, var(--text-faint) 22%, transparent); border-radius: 999px; overflow: hidden; }
    .bbar i { position: absolute; inset: 0 auto 0 0; border-radius: 999px; transition: width .6s; }
    .bbar u { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: .55; }
    .bnote { display: flex; justify-content: space-between; font-size: .78rem; color: var(--text-dim); }
    .legend { margin: .3rem 0 0; }
    .charger { display: flex; flex-direction: column; gap: .4rem; }
    .slots { display: flex; gap: .5rem; flex-wrap: wrap; }
    .slot { min-width: 5rem; text-align: center; padding: .5rem .8rem; border-radius: 10px; border: 2px dashed var(--border); color: var(--text-faint); font-weight: 700; font-size: .8rem; }
    .slot.used { border-style: solid; border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent) 16%, transparent); }

    .seg-dots { display: inline-flex; gap: 3px; } .seg-dots i { width: .55rem; height: .55rem; border-radius: 50%; background: color-mix(in srgb, var(--text-faint) 40%, transparent); }
    .seg-dots i.rel { background: var(--ok); }
    .zrow, .crow { display: flex; align-items: center; gap: .6rem; padding: .3rem 0; flex-wrap: wrap; }
    .crow .pbar { flex: 1; } .crow > span:first-child { min-width: 9rem; }
    .banner.ok { background: color-mix(in srgb, var(--ok) 14%, transparent); border-color: var(--ok); }

    .dets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
    .det { padding: .9rem 1rem; display: flex; flex-direction: column; gap: .45rem; border-left: 5px solid var(--ok); }
    .det.watch { border-left-color: var(--warn); } .det.firing { border-left-color: var(--crit); background: color-mix(in srgb, var(--crit) 8%, var(--surface)); }
    .det header { display: flex; gap: .4rem; } .det h3 { font-size: 1rem; } .det p { margin: 0; color: var(--text-dim); font-size: .8rem; }
    .rule { margin-top: auto; }
    .find { display: flex; align-items: center; gap: .6rem; padding: .45rem 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }

    @media (max-width: 1250px) { .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 1100px) { .grid2 { grid-template-columns: 1fr; } .dets { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 767px) { .tiles, .dets { grid-template-columns: 1fr; } .qhead { grid-template-columns: auto 1fr; } .pts, .best { grid-column: 1 / -1; text-align: left; } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `],
})
export class IntelPageComponent {
  protected readonly store = inject(IntelStore);
  protected readonly gw = inject(RealtimeGateway);
  private readonly facade = inject(OverrideFacade);
  private readonly route = inject(ActivatedRoute);

  protected readonly tabs = TABS;
  protected readonly tab = signal<Tab>((TABS.find((t) => t.id === this.route.snapshot.queryParamMap.get('tab'))?.id) ?? 'dispatch');
  protected readonly openTask = signal('');
  protected readonly d = this.store.data;

  protected readonly pctFmt = (n: number) => `${Math.round(n)} %`;
  protected readonly intFmt = (n: number) => String(Math.round(n));
  protected readonly oneFmt = (n: number) => String(Math.round(n * 10) / 10);
  protected readonly fmt = secs;
  protected readonly min = Math.min;

  protected readonly energySeries = computed<ChartSeries[]>(() => {
    const h = this.d()?.energy.history ?? [];
    return [{ name: 'Availability %', values: h.map((p) => p.a), color: 'var(--c1)' }, { name: 'Avg battery %', values: h.map((p) => p.b), color: 'var(--c2)' }];
  });
  protected readonly energyXs = computed(() => (this.d()?.energy.history ?? []).map((p) => new Date(p.t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })));
  protected readonly trafficSeries = computed<ChartSeries[]>(() => {
    const h = this.d()?.traffic.history ?? [];
    return [{ name: 'Robots waiting', values: h.map((p) => p.a), color: 'var(--c1)' }, { name: 'Congestion %', values: h.map((p) => p.b), color: 'var(--c2)' }];
  });
  protected readonly trafficXs = computed(() => (this.d()?.traffic.history ?? []).map((p) => new Date(p.t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })));

  protected readonly forecastSeries = computed<ChartSeries[]>(() => {
    const h = this.d()?.forecast.history ?? [];
    return [{ name: 'Actual', values: h.map((p) => p.a), color: 'var(--c1)' }, { name: 'Predicted', values: h.map((p) => p.b), color: 'var(--c2)' }];
  });
  protected readonly forecastXs = computed(() => (this.d()?.forecast.history ?? []).map((p) => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
  protected levelLabel(l: string) { return ({ LEARNING: 'Learning…', LOW: 'Low', NORMAL: 'Normal', HIGH: 'High — rush expected' } as Record<string, string>)[l] ?? l; }
  protected levelShort(l: string) { return ({ LEARNING: 'Learning…', LOW: 'Low demand', NORMAL: 'Normal demand', HIGH: 'High demand' } as Record<string, string>)[l] ?? l; }
  protected decLabel(t: string) { return ({ PRE_POSITION: '📍 Pre-positioned', KEPT_READY: '✔ Kept ready', RELEASED_EARLY: '⚡ Released early' } as Record<string, string>)[t] ?? t; }
  protected maxStation(d: Intel) { return Math.max(1, ...d.forecast.stations.map((s) => s.expected10)); }
  protected firing(d: Intel) { return d.anomalies.detectors.filter((x) => x.state === 'FIRING').length; }
  protected watching(d: Intel) { return d.anomalies.detectors.filter((x) => x.state === 'WATCH').length; }
  protected best(q: IntelQueueItem) { return q.candidates.find((c) => c.eligible) ?? null; }
  protected prio(p: IntelQueueItem['priority']) { return PRIO_COLOR[p]; }
  protected pct(points: number) { return Math.min(100, (points / 160) * 100); }
  protected loadPct(n: number) { const m = Math.max(1, ...(this.d()?.dispatch.load.map((l) => l.recentTasks) ?? [1])); return (100 * n) / m; }
  protected lvl(r: IntelEnergyRobot) { return LEVEL_COLOR[r.level]; }
  protected slotName(robots: string[], i: number): string { return i < robots.length ? robots[i] : 'free'; }
  protected slots(n: number) { return Array.from({ length: n }, (_, i) => i); }
  protected dots(n: number) { return Array.from({ length: Math.min(n, 10) }, (_, i) => i); }
  protected detColor(s: string) { return s === 'FIRING' ? 'var(--crit)' : s === 'WATCH' ? 'var(--warn)' : 'var(--ok)'; }
  protected stColor(s: string) { return ROBOT_STATUS_COLOR[s as keyof typeof ROBOT_STATUS_COLOR] ?? 'var(--text-dim)'; }
  protected stIcon(s: string) { return ROBOT_STATUS_ICON[s as keyof typeof ROBOT_STATUS_ICON] ?? '●'; }
  protected stLabel(s: string) { return ROBOT_STATUS_LABEL[s as keyof typeof ROBOT_STATUS_LABEL] ?? s; }

  protected reopen(id: string, label: string) { return this.facade.run({ type: 'UNBLOCK_ZONE', targetId: id }, `Reopen ${label}`, 'high'); }
}
