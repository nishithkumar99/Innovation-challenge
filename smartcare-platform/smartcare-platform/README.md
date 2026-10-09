# SmartCareLogistics – AMR fleet core (Java 21 · Spring Boot 3 · Docker) + Angular control UI

A hospital-logistics fleet manager for autonomous mobile robots (AMRs).
Tasks come in through a REST interface, the core decides **which robot does what, when it charges and which route it drives**,
and sends instructions to the robots over **MQTT using VDA 5050 v2.0.0**.

```
 Task source ──REST──▶  Spring Boot core  ──MQTT / VDA 5050──▶ AMRs (organisers' simulator or built-in one)
 Angular UI ◀─REST+WebSocket─┘   ▲  dispatching · energy · traffic/deadlocks · anomaly detection · KPIs
```

| Folder | What |
|---|---|
| `core/` | Java 21 / Spring Boot core, VDA 5050 layer, built-in vehicle simulator, 43 tests |
| `ui/` | Angular 20 control centre (works with the core, or alone with its in-browser mock) |
| `mosquitto/`, `docker-compose.yml` | Broker + the full stack in one command |
| `docs/TECHNICAL_DOCUMENTATION.md` | Architecture, algorithms, API, configuration, testing, limitations |

## 1. Run it on your laptop

### Option A – Docker (easiest, nothing else to install)
Install **Docker Desktop** (Windows/macOS) or Docker Engine + Compose plugin (Linux), then:

```bash
docker compose up --build
```
* UI: <http://localhost:8081> · Core API: <http://localhost:8080> · Health: <http://localhost:8080/actuator/health>
* MQTT broker: `localhost:1883` (watch the VDA 5050 traffic with MQTT Explorer / `mosquitto_sub -t 'uagv/#' -v`)

**With the organizers' VDA 5050 simulator (the only thing that moves robots):** `docker compose -f docker-compose.vda.yml up --build` (see docs section 9a). Then open the organizers' simulator window with `vda-visualizer/start_vda_window.bat`.

First build takes a few minutes (downloads Maven and npm dependencies). Stop with `Ctrl+C`, `docker compose down`.

### Option B – Developer mode (core with Maven, UI with Angular CLI)
Prerequisites: **JDK 21**, **Maven 3.9+**, **Node 20.19+ or 22** (for the UI).

| OS | Install |
|---|---|
| Windows | `winget install EclipseAdoptium.Temurin.21.JDK Apache.Maven OpenJS.NodeJS.LTS` (or Chocolatey) |
| macOS | `brew install openjdk@21 maven node` |
| Ubuntu/Debian | `sudo apt install openjdk-21-jdk maven` and Node from <https://nodejs.org> |

Check: `java -version` (21), `mvn -version`, `node -v`.

```bash
# terminal 1 – core (includes the built-in VDA 5050 simulator, no broker needed)
cd core
mvn spring-boot:run                 # http://localhost:8080

# terminal 2 – UI
cd ui
npm install
# switch the UI from the demo mock to the real core: edit  ui/public/config.js  ->  backend: 'real'
npm start                           # http://localhost:4200  (proxies /api and /ws to :8080)
```
Run the tests: `cd core && mvn test`.

### Option C – real MQTT broker without Docker for the core
Install Mosquitto (`brew install mosquitto`, `apt install mosquitto`, Windows installer), start it, then
```bash
cd core
SMARTCARE_MQTT_MODE=BROKER SMARTCARE_MQTT_HOST=localhost mvn spring-boot:run
```
(Windows PowerShell: `$env:SMARTCARE_MQTT_MODE="BROKER"; mvn spring-boot:run`.)

## 2. Using the organisers' simulator and task interface
* **Simulator**: start it so that it publishes VDA 5050 `state`/`connection` and subscribes to `order`/`instantActions` on the same broker.
  Then run the core with `SMARTCARE_MQTT_MODE=BROKER`, `SMARTCARE_SIM_ENABLED=false` and set
  `SMARTCARE_MQTT_INTERFACE_NAME`, `SMARTCARE_MQTT_MAJOR_VERSION` and `SMARTCARE_MAP_FILE` to match their topics and map.
  Their map (`route_nodes.json`) is already used as `core/src/main/resources/map/hospital.json`, and `ui/public/floorplan.png` is their floorplan (see technical documentation §9 and §9a).
* **Task interface**: their predefined REST spec is not known yet. `POST /api/external/transport-orders` is the adapter point –
  map their schema to `TaskRequest` in `ApiController` (≈10 lines). See §12 of the technical documentation for open questions for Mr. Zweck.

## 3. Try it
Open the UI → persona selector (top right) → *Fleet operator* → **Simulator** → *Burst* → *Start*, then **Control center**.
Or via REST:
```bash
curl -X POST localhost:8080/api/tasks -H 'Authorization: Bearer mock.u-op' -H 'Content-Type: application/json' \
  -d '{"source":"PHARMACY","from":"PH","to":"WA","priority":"URGENT","item":"Insulin","origin":"REAL"}'
```
Dev authentication is `Bearer mock.<userId>` with users `u-staff`, `u-staff2`, `u-staff3`, `u-staff4` (nurses), `u-lead`, `u-op`, `u-mgr`, `u-admin` – replace by OIDC/JWT for production.

## 4. Where the four focus areas live
| Focus area | Code (`core/src/main/java/de/smartcare/core/`) |
|---|---|
| Intelligent task distribution | `engine/Dispatcher`, `dispatch/Hungarian` |
| Intelligent energy management | `engine/EnergyManager` |
| AI-based process control | `engine/TrafficController`, `traffic/*`, `engine/Predictor`, `routing/Router` |
| Anomaly detection | `engine/AnomalyDetector`, `anomaly/Welford`, `insight/*` |
