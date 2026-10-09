package de.smartcare.core.settings;

/**
 * All tunable parameters with their defaults. Plain public fields so the domain code stays framework free.
 * In the Spring layer every field is bound from {@code smartcare.<section>.<field-in-kebab-case>}
 * (application.yml, environment variables such as SMARTCARE_ENERGY_LOW_PCT, or command line).
 */
public final class Settings {
    public Core core = new Core();
    public Mqtt mqtt = new Mqtt();
    public MapCfg map = new MapCfg();
    public Dispatch dispatch = new Dispatch();
    public Energy energy = new Energy();
    public Traffic traffic = new Traffic();
    public Anomaly anomaly = new Anomaly();
    public Sim sim = new Sim();
    public Llm llm = new Llm();
    public Ai ai = new Ai();

    public static final class Core {
        /** false = this process only runs the vehicle simulator (docker-compose "sim" service). */
        public boolean enabled = true;
        /** Comma separated browser origins allowed to call the REST API / WebSocket (CORS). */
        public String allowedOrigins = "http://localhost:4200,http://localhost:8081,http://localhost:8080";
        /** If set, /api/external/** requires this value in the X-Api-Key header. */
        public String externalApiKey = "";
        /** Main control loop period. */
        public long tickMs = 250;
        /** How often changed robots are pushed to the UI. */
        public long telemetryMs = 500;
        /** A robot that has not answered a new order with a matching state after this long is considered unresponsive. */
        public double orderAckTimeoutS = 10;
        /** No state message for this long marks a robot offline. */
        public double robotOfflineS = 15;
        public int taskRetention = 500;
        /** Send idle vehicles that do not stand on a node (e.g. at start-up) to a free home node. */
        public boolean autoHome = true;
        /** Home nodes, in no particular order: normally the charging stations. */
        public String homeNodes = "Charging_Station1_Hallway,Charging_Station2_Hallway,Charging_Station3_Hallway,Charging_Station4_Hallway";
        /** An idle vehicle that has stood this long on a node that is not a home node goes to a free home node (0 = stay where it is). */
        public double parkAfterS = 20;
        /** A vehicle farther than this from the node it is assigned to counts as "not on a node". */
        public double homeToleranceM = 1.0;
        /** Site id echoed to the UI. */
        public String siteId = "klinikum-nord";
    }

    public static final class Mqtt {
        /** INTERNAL = in-process loopback (no broker, for demos/tests). BROKER = real MQTT broker via Eclipse Paho. */
        public String mode = "INTERNAL";
        public String host = "localhost";
        public int port = 1883;
        public String username = "";
        public String password = "";
        public String clientId = "smartcare-core";
        /** VDA 5050 topic structure: {interfaceName}/{majorVersion}/{manufacturer}/{serialNumber}/{topic}. */
        public String interfaceName = "uagv";
        public String majorVersion = "v2";
        public int orderQos = 0;
        public int instantActionQos = 0;
        public int stateQos = 0;
        public int connectionQos = 1;
        /** Map identifier sent in node positions. */
        public String mapId = "webots";
        /** VDA action types for the three things the core asks a vehicle to do. Blank = send no action (the vehicle does it by itself, e.g. charges when stopped on a charging node). */
        public String pickAction = "pick";
        public String dropAction = "drop";
        public String chargeAction = "startCharging";
        /**
         * HORIZON = VDA 5050 base/horizon with order updates (own simulator, spec-compliant vehicles).
         * STEPWISE = one order per released stretch, for vehicles without horizon support such as the organizers' simulator.
         */
        public String orderMode = "HORIZON";
    }

    public static final class MapCfg {
        /** classpath:... or file path. */
        public String file = "classpath:map/hospital.json";
        /** Floorplan size in metres (the simulator's floorplan_x / floorplan_y). 0 = derive from the nodes. */
        public double width = 65;
        public double height = 40;
        /** Image the UI draws behind the map (served by the UI at /floorplan.png). */
        public String backgroundImage = "floorplan.png";
        /** A vehicle that reports no node but stands within this distance of one is treated as being at that node. */
        public double snapRadiusM = 8.0;
    }

    public static final class Dispatch {
        /** AUTO = every task is assigned. SEMI_AUTO = only STAT tasks, others wait for an operator. */
        public String mode = "AUTO";
        public boolean hungarian = true;
        public int maxBatch = 12;
        /** Seconds of cost per task a robot completed in the recent window (load balancing). */
        public double weightLoadBalance = 25;
        /** Seconds of cost per percent of battery below 60 (prefer healthy vehicles). */
        public double weightBattery = 0.6;
        /** Seconds of cost per unit of current congestion on the route. */
        public double weightCongestion = 20;
        public double recentWindowS = 600;
        public double agingPerMin = 5;
        public double agingCap = 60;
        public double handoverS = 2.0;
    }

    public static final class Energy {
        public double criticalPct = 15;
        public double lowPct = 30;
        public double targetPct = 90;
        /** A charging robot may be released early when work is waiting and it has at least this much. */
        public double minReleasePct = 60;
        /** Idle robots below this level top up when no work is waiting. */
        public double opportunisticBelowPct = 60;
        public double reservePct = 8;
        public double defaultPctPerMeter = 0.04;
    }

    public static final class Traffic {
        public int lookaheadSegments = 2;
        /**
         * true = a vehicle is released onto its whole remaining route at once or not at all (all-or-nothing reservation).
         * Nothing is held while waiting, so vehicles cannot deadlock while holding part of each other's route; this is the
         * safe setting for vehicles that cannot be held back mid-route. false = reserve {@code lookaheadSegments} ahead.
         */
        public boolean reserveWholeRoute = false;
        /** Keep routes off the charging stations unless one is the destination (a vehicle that passes a charger may stop there). */
        public boolean avoidChargersAsVia = true;
        public double nodeClearanceM = 1.5;
        /**
         * Vehicles whose centres are closer than this collide (the simulator's two collision radii add up to 1.0 m).
         * Used to keep a node that lies beside a corridor from being occupied while another vehicle drives along that corridor, and to
         * hold a vehicle back while another one stands in front of it. 0 = off (vehicles that cannot collide, e.g. the built-in simulator).
         */
        public double physicalClearanceM = 0;
        /** A vehicle that is cleared to drive but has not moved for this long, with a neighbour in its way, asks an idle neighbour to step aside. */
        public double yieldWaitS = 3;
        public double deadlockMinWaitS = 5;
        public double stationCapacityDefault = 3;
        /** Congestion horizons in minutes mapped to the UI's +5/+15/+30. */
        public double predictionLoadThreshold = 1.0;
    }

    public static final class Anomaly {
        public double idleWarnS = 600;
        public double queuedWarnS = 180;
        public double noProgressS = 45;
        public double batteryZ = 3.0;
        public int minSamples = 6;
        public double bottleneckWaitS = 15;
        public int bottleneckMinRobots = 2;
        public boolean autoResolveDeadlocks = true;
    }

    public static final class Sim {
        public boolean enabled = true;
        public int robots = 5;
        public double speedMps = 4.0;
        public double actionSeconds = 2.0;
        public double drainPctPerMeter = 0.03;
        public double idleDrainPctPerMin = 0.05;
        public double chargePctPerSec = 1.5;
        public double stateHz = 2.0;
        public String manufacturer = "SmartCareSim";
        public String startNodes = "Charging_Station1_Hallway,Charging_Station2_Hallway,Charging_Station3_Hallway,Charging_Station4_Hallway,Waypoint_Hallway_North";
        public double startBattery = 85;
    }

    public static final class Llm {
        /** Optional natural-language explanations for insights. Never executes anything. */
        public boolean enabled = false;
        public String endpoint = "https://api.anthropic.com/v1/messages";
        public String model = "claude-sonnet-5-5";
        public String apiKey = "";
        public int timeoutMs = 8000;
        public int maxTokens = 400;
    }

    /** Learned demand forecast and what the core does with it (smartcare.ai.*). */
    public static final class Ai {
        /** Use the demand forecast for charging decisions and robot positioning. */
        public boolean forecast = true;
        /** Length of one learning bucket. */
        public double bucketSeconds = 60;
        /** Buckets that must be observed before the forecast is acted upon. */
        public int minBuckets = 5;
        /** Expected orders in the next 10 minutes from which demand counts as "high". */
        public double busyOrdersPer10Min = 2.0;
        /** Move idle robots to the pickup station where most orders are expected. */
        public boolean prePosition = true;
        /** Minimum expected orders (next 10 min) at a station before a robot is sent there. */
        public double prePositionMinOrders = 0.8;
        public double prePositionMinBattery = 50;
        public double prePositionCooldownS = 60;
    }
}
