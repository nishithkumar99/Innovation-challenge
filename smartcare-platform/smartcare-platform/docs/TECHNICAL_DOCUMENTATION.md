# SmartCareLogistics Core – Technical Documentation

Version 0.1 · Java 21 · Spring Boot 3.3.5 · VDA 5050 v2.0.0 · Angular 20 UI

## 1. Purpose and scope

The system receives transport tasks (pickup → delivery) for a hospital, assigns them to autonomous mobile robots (AMRs), keeps the
fleet charged, coordinates robots so they do not block each other, detects anomalies, and exposes everything to an operator UI.
The robots (or the organisers' simulator) are driven exclusively through **MQTT with VDA 5050 v2.0.0**.

Covered focus areas of the challenge: **(1) intelligent task distribution, (2) intelligent energy management,
(3) AI-based process control (multi-AMR coordination, deadlocks, travel-time optimisation, congestion), (4) anomaly detection.**
Mandatory stack: Java, Spring Boot, Docker – all used.

> "AI" here means optimisation and statistics (Hungarian assignment, Dijkstra with learned edge times, wait-for-graph deadlock
> detection, EWMA/z-score anomaly detection, congestion forecast). An optional LLM only *explains* findings in plain language;
> it never decides or executes anything.

## 2. Architecture

```
┌─────────────┐  REST /api, WebSocket /ws   ┌──────────────────────────── Spring Boot core ───────────────────────────┐
│ Angular UI  │◀───────────────────────────▶│ app/ (Spring: REST, WS, config, scheduler)                              │
└─────────────┘                             │   └─ api/ Api, Rbac, Scope  (auth rules, per-user filtering)            │
┌─────────────┐  REST (organisers' spec)    │       └─ engine/ CoreEngine  (single lock, tick loop)                   │
│ Task source │────────────────────────────▶│            Dispatcher · EnergyManager · TrafficController · Predictor   │
└─────────────┘                             │            AnomalyDetector · MissionService · CommandService · KPIs     │
                                            │       └─ vda/ messages, topics, OrderFactory   mqtt/ gateway            │
                                            └───────────────────────────────┬─────────────────────────────────────────┘
                                                                            │ MQTT  uagv/v2/{manufacturer}/{serial}/{order|instantActions|state|connection}
                                            ┌───────────────────────────────▼───────────────┐
                                            │ Mosquitto ◀──▶ AMRs / organisers' simulator   │  (or built-in sim/AmrSimulator)
                                            └───────────────────────────────────────────────┘
```

**Design decisions**
* **Framework-free domain.** Everything except `app/` is plain Java (no Spring annotations). It is unit/e2e-testable on a virtual clock
  without any container, and the Spring layer is only HTTP/WebSocket/config glue.
* **One lock.** MQTT callbacks, REST calls and the periodic `tick()` all run under a single `ReentrantLock` in `CoreEngine`.
  Planning code is therefore single-threaded and race-free (the fleet is small; throughput is not the constraint).
* **Pluggable MQTT.** `MqttGateway` has two implementations: `LoopbackBroker` (in-process, `mode=INTERNAL`, zero setup) and
  `PahoMqttGateway` (Eclipse Paho, `mode=BROKER`, auto-reconnect and re-subscribe).
* **Realtime protocol.** Every event gets a global sequence number (`EventBus`). The UI loads `/api/fleet/snapshot` (contains `seq`)
  and then applies WebSocket envelopes; a gap triggers a resync.
* **Non-blocking fan-out.** WebSocket sends go through a bounded per-client queue so a slow browser can never stall the control loop.

### Package map (`core/src/main/java/de/smartcare/core/`)
| Package | Content |
|---|---|
| `model` | `HospitalMap` (graph loaded from JSON), nodes, edges, zones |
| `routing` | `Router` (Dijkstra, learned edge times, blocked edges, congestion penalty), `Path`, `Ewma` |
| `vda` | VDA 5050 records (`Messages`), `Codec` (Jackson), `Topics`, `OrderFactory` |
| `mqtt` | `MqttGateway`, `LoopbackBroker`, `PahoMqttGateway` |
| `fleet`, `task`, `mission` | `Robot` (digital twin), `Task`, `Mission`/`Leg` |
| `engine` | `CoreEngine`, `Dispatcher`, `EnergyManager`, `TrafficController`, `Predictor`, `AnomalyDetector`, `MissionService`, `CommandService` |
| `traffic`, `dispatch`, `anomaly` | `ReservationTable`, `DeadlockDetector`, `Hungarian`, `Welford` |
| `kpi`, `insight` | KPI computation; `Insight`, optional `AnthropicNarrator` |
| `api` | `Api` (application service), `Rbac`, `Scope`, `User` |
| `sim` | `AmrSimulator` – VDA 5050 vehicle simulator over MQTT |
| `app` | Spring: `SmartCareApplication`, `CoreConfiguration`, `ApiController`, `WebSocketConfig`, `Scheduler` |

## 3. VDA 5050 integration

Topics: `{interfaceName}/{majorVersion}/{manufacturer}/{serialNumber}/{topic}` – defaults `uagv/v2/...`
(configurable). The core subscribes to `uagv/v2/+/+/state` and `.../connection`; publishes `order` and `instantActions`.

| Aspect | Implementation |
|---|---|
| Order | `orderId` unique per leg, `orderUpdateId` increments with every update; node `sequenceId = 2i`, edge `= 2i+1`; `released` flag implements **base/horizon** |
| Order update | Sent when more of the route is reserved; **starts at the previous base end node** as required; also used to re-route a waiting vehicle (horizon replaced) |
| Actions | `pick`, `drop` (blocking HARD, parameter `taskId`) at the last node of the pickup/drop leg; `startCharging` at the charger |
| Instant actions | `startPause`, `stopPause`, `cancelOrder`, `stopCharging` |
| State use | `lastNodeId`/`lastNodeSequenceId` (progress), `agvPosition`, `batteryState.charging/batteryCharge`, `driving`, `paused`, `actionStates`, `errors` (FATAL ⇒ fault), `orderId` (ack check) |
| Connection | `ONLINE` / `OFFLINE` / `CONNECTIONBROKEN`; additionally no state for `robot-offline-s` ⇒ offline, its task is re-queued |
| Ack timeout | vehicle's state does not carry the new `orderId` within `order-ack-timeout-s` ⇒ mission failed, task re-queued, vehicle excluded for that task |
| QoS | order 0, instantActions 0, state 0, connection 1 (retained) – configurable |

Not implemented (not needed for the scenario): `factsheet`, `visualization`, zone sets, `initPosition`, edge trajectories (NURBS), load handling beyond pick/drop,
`clearErrors`. Unknown fields in incoming messages are ignored, so vendor extensions do no harm.

## 4. Focus area 1 – task distribution (`Dispatcher`)

1. **Queue order**: priority points `STAT 100 / URGENT 50 / ROUTINE 20` plus **aging** (`+5` points per minute waiting, capped at `+60`) so low-priority work cannot starve.
2. **Eligible vehicles**: online, not manual/paused/faulted, no mission, battery above `critical-pct`; charging vehicles only above `min-release-pct`.
3. **Cost** of a (task, vehicle) pair: travel time to pickup on the current graph (learned edge times + congestion penalty)
   `+ weight-load-balance × tasks done recently` (fairness / **load balancing**) `+ weight-battery × (100 − battery)`
   `+ weight-congestion × reserved edges on the way` `+ 15 s if it must leave the charger`, divided by `priorityPoints/20`
   so urgent work wins scarce vehicles. Pairs whose energy need (pickup + delivery + trip to nearest charger + reserve) exceeds the battery are forbidden.
4. **Assignment**: the batch (≤ `max-batch` tasks) is solved **optimally with the Hungarian algorithm** (rectangular, handles more tasks than robots by transposition). `dispatch.hungarian=false` switches to greedy.
5. The decision is visible at `GET /api/diagnostics` (`lastDispatch`). Operators can re-assign (`REASSIGN`), cancel, change priority.

## 5. Focus area 2 – energy management (`EnergyManager`)

* Battery is read from every state message. **Learned consumption**: after each leg, `%/m` is fed into an EWMA (used for range planning; default 0.04 %/m until learned) and a Welford accumulator (anomaly detection).
* Policy: `< critical-pct` (15) no new work; idle `< low-pct` (30) ⇒ charge; idle `< opportunistic-below-pct` (60) with an empty queue (AUTO mode) ⇒ **opportunistic charge**;
  charging stops at `target-pct` (90) or earlier at `min-release-pct` (60) when work waits and the dispatcher picks that vehicle.
* **Charger selection**: nearest charger by travel time with a free slot (capacity from the map, reservation-aware).
* Availability: vehicles are never dispatched on a trip they cannot finish; consumption outliers raise an insight (§7).

## 6. Focus area 3 – process control (`TrafficController`, `Predictor`, `Router`)

* **Space reservations** (`ReservationTable`): edges are single-lane (capacity 1, no passing / head-on); nodes use their capacity (junctions 1, stations 3, charger 2).
  A vehicle only receives (releases in VDA terms) `lookahead-segments` (2) ahead of its last node if edge **and** target node can be reserved atomically; the rest is horizon.
* **Deadlock detection**: blocked vehicles form a wait-for graph; a vehicle waiting ≥ `deadlock-min-wait-s` participates; any **cycle** is a deadlock (`DeadlockDetector`).
* **Resolution** (AUTO mode, `auto-resolve-deadlocks`): victim = vehicle without cargo, then lowest task priority, then least progress; it is **re-routed** around the contested node/edge
  (Dijkstra with avoid-constraints) via an order update. Also re-routes around idle/manual vehicles and blocked zones. If no alternative exists the insight stays CRITICAL for the operator.
  In SEMI_AUTO mode the core only reports.
* **Travel-time optimisation**: Dijkstra on *time*, not distance: observed edge times, current reservations and the +5 min forecast add penalties, so routes avoid busy corridors.
* **Congestion forecast** (`Predictor`): every active mission is rolled forward along its route using edge times; queued tasks are added with weight 0.6 at the time a vehicle is likely to be free.
  Utilisation per edge in windows around +5/+15/+30 min; `severity = min(1, utilisation / prediction-load-threshold)`; ≥ 0.35 is published as hotspot on `ai.predictions`.
* **Restricted areas / bottlenecks**: `BLOCK_ZONE` (edge) removes an edge from routing and re-routes waiting vehicles; zones with `restricted:true` in the map are excluded from routes.

## 7. Focus area 4 – anomaly detection (`AnomalyDetector`)

Findings become **insights** (`ai.insights`) with a stable key (no duplicates), severity, confidence, optional suggested command the operator can apply, and a plain-language message for staff.

| Detector | Rule | Default |
|---|---|---|
| Long idle time | idle > `idle-warn-s`, battery fine | 600 s |
| Unprocessed/blocked order | task QUEUED longer than `queued-warn-s` (×0.34 STAT, ×0.67 URGENT) | 180 s |
| Stalled vehicle | order running, route released, but position unchanged for `no-progress-s` | 45 s |
| Abnormal battery use | z-score of %/m for a leg ≥ `battery-z` after `min-samples` legs | 3.0 / 6 |
| Critical battery on task | battery ≤ critical while carrying out a task | – |
| Offline vehicle | no state / connection lost | 15 s |
| Deadlock | wait-for cycle (WARNING if auto-resolved, CRITICAL otherwise) | – |
| Traffic bottleneck | ≥ `bottleneck-min-robots` waiting > `bottleneck-wait-s` for the same node | 2 / 15 s |
| Forecast congestion | hotspot severity ≥ 0.85 within 15 min | – |

Lifecycle: `NEW → ACKNOWLEDGED → ACTION_APPLIED | DISMISSED (suppressed 10 min) | RESOLVED` (auto when the condition disappears).
Optional **LLM narrator** (`smartcare.llm.enabled=true`, `api-key`): rewrites the staff message asynchronously (own thread, 8 s timeout); on any failure the rule-based text stays.

## 7a. AI Control page and `GET /api/intel`
The UI page **AI Control** (`/ai`, sidebar ✦, operators and above) makes the four focus areas visible. It polls `GET /api/intel` every 2 s (`IntelService`, read-only, built under the core lock):

| Tab | What the operator sees | Source |
|---|---|---|
| Task distribution | priority queue with points (base + aging), per order the ranked vehicles with ETA, battery, recent jobs, cost and the reason a vehicle is excluded; fair-share score and jobs per robot; latest assignments | `Dispatcher.points/cost/queue` |
| Energy | battery per robot with critical/low/target marks, what the policy does next, range, charger slots (occupied / on the way), availability %, trend | `EnergyManager`, `ReservationTable` |
| Process control | per-robot route progress and waits, deadlocks (+ how resolved), bottleneck nodes, restricted zones (map file) and closed corridors (with *Reopen*), learned vs free-flow corridor times, +5/+15/+30 min forecast, trend | `TrafficController`, `Predictor`, `Router` |
| Anomalies | six watchers (idle time, battery consumption, blocked/unprocessed orders, bottlenecks, deadlocks, offline) with state OK / WATCH (≥ 70 % of limit) / FIRING, current value vs limit, recent findings | `AnomalyDetector`, `Settings.anomaly` |

In mock mode (`backend: 'mock'`) the same shape is derived from the simulated fleet (`mock-intel.ts`). Restricted areas come from `zones[].restricted` in the map file; the shipped hospital map defines none, so the page then explains how to add one.

## 7b. AI model: learned demand forecast (`ai/DemandForecaster`)
**What it is.** An online-learning forecaster written in plain Java (no external service, no separate training run). For every pickup station it learns orders per time bucket (default 60 s) from (1) an exponentially smoothed *level* of recent arrivals and (2) an hour-of-day *profile* that learns rush hours over days; the forecast is `0.6·level + 0.4·profile`. After each bucket it compares forecast and reality and keeps its mean absolute error next to a naive baseline ("same as the last bucket"), both shown on the AI Control page (tab *AI forecast*). It is trusted once `ai.min-buckets` buckets were observed.

**What the core does with it** (only when `ai.forecast=true` and the model is ready):
* **Adaptive charging** (`EnergyManager`): if the expected demand in the next 10 min is ≥ `ai.busy-orders-per-10-min`, idle robots between 30 % and 60 % stay available instead of topping up (`KEPT_READY`), and robots charging with ≥ 60 % leave the charger early (`RELEASED_EARLY`). When it is quiet they charge as before.
* **Pre-positioning** (`Positioner`): with an empty queue, one free healthy robot (battery ≥ `ai.pre-position-min-battery`) is sent to the pickup station with the highest expected demand if no robot is there yet (`PRE_POSITION`, at most one move per 5 s, cooldown per robot).
* Safety rules are unchanged: robots below the critical level never get work, dispatch hold / semi-auto mode disable pre-positioning, the optimiser (Hungarian) and traffic control are untouched.

**Settings** (`smartcare.ai.*`, all optional): `forecast`, `bucket-seconds`, `min-buckets`, `busy-orders-per-10-min`, `pre-position`, `pre-position-min-orders`, `pre-position-min-battery`, `pre-position-cooldown-s`.

**Replacing or extending the model.** `DemandForecaster` is the only class that predicts; `expected(station, now, minutes)` is its whole contract, so a gradient-boosting or LSTM model (e.g. served over HTTP, or an ONNX model in-process) can replace it without touching the rest. The LLM stays an optional narrator and never decides.

## 8. APIs

### REST (all need `Authorization: Bearer mock.<userId>` in dev)
| Method & path | Purpose | Permission |
|---|---|---|
| `POST /api/tasks` (`Idempotency-Key`) | create task `{source,from,to,priority,item,notes,origin}` → `201 {taskId}` | `task:create` |
| `POST /api/tasks:validate` | `{ok,errors,warnings}` | `task:create` |
| `POST /api/tasks/{id}/commands` | `CANCEL_TASK`, `REASSIGN {robotId?}`, `SET_PRIORITY {priority}` | own cancel / `task:modify:any` |
| `POST /api/robots/{id}/commands` | `PAUSE`, `RESUME`, `ESTOP`, `RESET`, `CHARGE`, `GOTO {nodeId}`, `TAKE_MANUAL`, `RELEASE_MANUAL` | `override:robot` (`override:estop` for ESTOP) |
| `POST /api/zones/{edgeId}/commands` | `BLOCK_ZONE`, `UNBLOCK_ZONE` | `override:fleet` |
| `POST /api/fleet/commands` | `FLEET_HOLD`, `FLEET_RESUME`, `SET_MODE {mode: AUTO\|SEMI_AUTO}` | `override:fleet` |
| `POST /api/insights/{id}/apply \| dismiss \| acknowledge` | act on insight | `insight:act` |
| `GET /api/fleet/snapshot` | full state + `seq` (filtered per user) | `fleet:view` |
| `GET /api/kpi/series?window=SHORT\|HOUR\|SESSION` | KPI trend | `kpi:view:basic` |
| `GET /api/fleet/map` | nodes/edges | – |
| `GET /api/intel` | explanation of AI decisions for the **AI Control** page (see §7a) | `fleet:view:full` |
| `GET /api/diagnostics`, `GET /api/audit` | internals / audit trail | `fleet:view:full` / `audit:view` |
| `POST /api/ws/ticket` | short-lived single-use WebSocket ticket | any user |
| `POST /api/external/transport-orders` | **adapter point** for the organisers' task interface (`X-Api-Key` if configured) | api key |
Commands are asynchronous: HTTP `202 {correlationId}`; terminal state `DONE`/`REJECTED` arrives on the WebSocket topic `commands.acks`. Errors: `{error,status}` with 400/401/403/404.

### WebSocket `/ws?ticket=…`
Envelope `{topic, seq, ts, payload}`. Topics: `fleet.robots` (array), `tasks.events` (array), `fleet.zones`, `ai.predictions`, `ai.insights` (one insight),
`commands.acks`, `kpi.live`, `system.status`. Staff users only receive their own tasks and the robot serving them; other topics keep their `seq` with `payload:null`.
Cadence: robots 0.5 s, zones/predictions/KPI 1 s.

### RBAC
`STAFF` (create/see own, cancel own) ⊂ `DEPT_LEAD` (+ department view, basic KPI) ⊂ `OPERATOR` (+ all tasks, overrides, insights) ⊂ `MANAGER` (+ fleet commands, full KPI, audit) ⊂ `ADMIN`.
Dev tokens `mock.u-staff|u-staff2|u-staff3|u-staff4|u-lead|u-op|u-mgr|u-admin` (nurses: Ward A, Ward C, Ward D, Operating Room; each sees only their own requests).

## 9. Configuration
`core/src/main/resources/application.yml`; every key can be an environment variable (`smartcare.energy.low-pct` → `SMARTCARE_ENERGY_LOW_PCT`).
| Key | Default | Meaning |
|---|---|---|
| `smartcare.mqtt.mode` | `INTERNAL` | `INTERNAL` loopback, `BROKER` real MQTT |
| `smartcare.mqtt.host/port/username/password` | localhost/1883 | broker |
| `smartcare.mqtt.interface-name/major-version/map-id` | `uagv`/`v2`/`webots` | VDA topic prefix, map id in node positions (must equal the simulator's `map_id`) |
| `smartcare.mqtt.pick-action/drop-action/charge-action` | `pick`/`drop`/`startCharging` | VDA action types sent at the pickup, drop-off and charger node; blank = send no action |
| `smartcare.map.file` | `classpath:map/hospital.json` | the organizers' `route_nodes.json` (or `file:/path.json`) |
| `smartcare.map.width/height/background-image/snap-radius-m` | 65/40/`floorplan.png`/3.0 | floorplan size in metres (`floorplan_x/y`), image the UI draws, distance within which a vehicle that reports no node is treated as standing at the nearest one |
| `smartcare.core.enabled` / `tick-ms` | true / 250 | false = simulator-only process |
| `smartcare.core.robot-offline-s`, `order-ack-timeout-s` | 15 / 10 | |
| `smartcare.core.allowed-origins`, `external-api-key` | localhost origins / "" | CORS + WS origin; key for external endpoint |
| `smartcare.dispatch.mode/hungarian/max-batch/weight-*/aging-*` | AUTO/true/12 … | see §4 |
| `smartcare.energy.*-pct`, `default-pct-per-meter` | 15/30/90/60/60/8 | see §5 |
| `smartcare.traffic.lookahead-segments/deadlock-min-wait-s/prediction-load-threshold` | 2/5/1.0 | see §6 |
| `smartcare.anomaly.*` | see §7 | |
| `smartcare.sim.enabled/robots/speed-mps/start-nodes/start-battery/manufacturer` | true/5/4.0/… | built-in simulator |
| `smartcare.llm.enabled/api-key/model/endpoint` | false | optional narrator |

**Map file.** The shipped `core/src/main/resources/map/hospital.json` is the organizers' simulator file `route_nodes.json`, unchanged: a JSON array of `{node_id, x, y, charging_station?, neghbour_nodes[]}` (their spelling). The loader derives the rest:

* an **edge** exists when both nodes list each other (the same rule as the simulator's visualizer); edge id `a-b`, length = distance in metres;
* **display name** from the id (`Charging_Station1_Hallway` → *Charging Station 1*), **station kind** from the prefix: `Pharmacy_`, `Ward…_`, `OR_…_`, `Storage_`, `Kitchen_`, `Laundry_`, `Waste_`, `Check-In_`, `Charging_`/`charging_station: true`, and `Waypoint_` = pure routing node;
* one vehicle per node (`station-capacity-default: 1`), because the simulator keeps vehicles one footprint apart.

The UI does not carry its own map any more: it loads `GET /api/fleet/map` from the core at start-up (`mapId`, `width`, `height`, `background`, nodes, edges) and draws the organizers' `floorplan.png` (in `ui/public/`) behind it. Without the core (demo mode) it uses a bundled copy of the same node file (`ui/src/app/core/sim-route-nodes.ts`). To use an updated map, replace `hospital.json` and `ui/public/floorplan.png` (and `sim-route-nodes.ts` for demo mode) and rebuild.

The older native format (`{"world","nodes":[{id,name,x,y,kind}],"edges":[{a,b}],"zones":[…]}`) is still read; it is what the unit tests use (`src/test/resources/map/test-hospital.json`). Restricted zones exist only in that format; the organizers' file has none.

### 9a. Running the organizers' VDA 5050 simulator (the only thing that moves robots)
Start everything with the overlay compose file; nothing in `docker-compose.yml`, the mosquitto config or the UI is changed:

```
docker compose -f docker-compose.vda.yml up --build
```

Services: `mosquitto`, `vda-sim` (the organizers' **unmodified** Python simulator, vendored in `vda-simulator/`, configured only by `VDA_*` environment variables), `core` (Spring profile `vda`), `ui`. The built-in Java simulator is not started. Everything we add around the simulator is Java/Spring Boot.

What the simulator really does (verified against it, not assumed):
* Topics `uagv/v2/rikeb/<serial>/…`, serials `AMR1`–`s14`, map id `webots`. Speed `0.05` m **per 50 ms tick = about 1 m/s** (so `SMARTCARE_SIM_SPEED_MPS` = `VDA_SPEED` x 20 = `1.0`, set by the profile). State is published at 1 Hz.
* It ignores the `released` flag, accepts a new order only when the previous one has no nodes or edges left, and clears action states when an order ends. It has no pause and does not support base/horizon.
* Vehicles spawn in a row 1.0 m apart that is not on a node; two vehicles stop when their centres are closer than 1.0 m (collision radius 0.5 each). Charging cannot be left before 100 %.

How the core copes (profile `vda`, file `application-vda.yml`):
* `order-mode: STEPWISE` (`vda/SegmentedOrders`): the core keeps planning with base/horizon, the adapter hands the vehicle one order per released stretch (id `<orderId>~n`, re-sent after 2.5 s without acknowledgement, 1.2 s hold after cancel, pause emulated as a hold) and rewrites the incoming state back to the core's order id, so the core, UI and API see ordinary VDA 5050.
* `traffic.reserve-whole-route: true`: a vehicle is released on its whole remaining route or not at all (atomic reservation), so nothing is held while waiting.
* `traffic.physical-clearance-m: 1.0`: a node that lies beside a corridor (e.g. Ward1 on the North-West line) is treated as part of that corridor; a vehicle is also held back while another stands in front of it; idle vehicles in the way are asked to step aside.
* `core.auto-home` / `park-after-s: 20`: vehicles that start off-node or stand idle in a corridor are sent to a free charging station; parking is skipped while the fleet is busy or blocked.
* `traffic.avoid-chargers-as-via: true`: a vehicle that drives over a charging node starts charging there and would be locked until 100 %, so routes avoid chargers unless one is the destination. `charge-action` is empty (the simulator charges by itself).

**Separate VDA simulator window.** `vda-visualizer/` is the organizers' unmodified Matplotlib visualizer. It subscribes to the broker (`localhost:1883`), discovers AMR1-s14 by itself and draws the same robots the UI shows. Run `vda-visualizer/start_vda_window.bat` (or `python visualizer.py`) on the host while the stack runs; it is a desktop window, so it does not run inside Docker. Checked: it discovers all five robots and their positions from the running simulator.

Test status (core against the real simulator through mosquitto): 2 simultaneous tasks done in about 60 s; staggered tasks 6/8 in about 350 s without a final deadlock; a burst of 8 simultaneous tasks delivered 6 in 420 s while the remaining two waited behind moving vehicles and one deadlock was recorded and repaired by re-routing. Under heavy simultaneous load the controller is conservative and slow; occasional jams in tight map regions can still occur. Not exercised: long charge cycles, core restart with stale simulator orders. For the panel, submit tasks a few seconds apart.

## 11. Known limitations
* Single-lane edges, no passing; parked idle vehicles on junctions can block corridors (the controller re-routes around them, there is no automatic "park aside" yet).
* Reservations are node/edge based (no geometric clearance / vehicle size, `nodeClearanceM` is reserved for later).
* Dev authentication only; production needs OIDC/JWT (Spring Security resource server) and TLS on REST/WS/MQTT.
* State is in memory (restart clears tasks and learned values); no database.
* Single core instance (no clustering).
* Prediction and forecasting are heuristic; KPI "staff minutes saved" assumes 8 min per manual delivery.

## 12. Open questions for the organisers (kick-off with Mr. Zweck)
1. Exact REST schema, authentication and error semantics of the task interface; does it expect status callbacks (polling or webhooks)?
2. Simulator: *(answered by `config.toml`: `uagv`/`v2`, manufacturer `rikeb`, serials `s1…`, map id `webots`)*. Still open: how it handles an order whose first node is not the vehicle's position, and whether it needs `factsheet` or `initPosition`.
3. Map: *(answered by `route_nodes.json`, metres, origin bottom-left, 65 × 40 m)*. Still open: are edges directed, and may two vehicles share a node?
4. Which actions do the robots support? Their visualizer refers to `dropOff`, the README to charging simply by stopping on a charging node. The names the core sends are configurable (`smartcare.mqtt.pick-action/drop-action/charge-action`, blank = none).
5. Behaviour on order update vs. new order, `newBaseRequest` handling, and whether pausing/`cancelOrder` is supported.
6. Battery model: charge rate, thresholds, can charging be interrupted?
7. Which of the four focus areas will be assessed and with which scenarios/KPIs?
