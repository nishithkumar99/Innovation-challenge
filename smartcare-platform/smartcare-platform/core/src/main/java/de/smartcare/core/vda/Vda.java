package de.smartcare.core.vda;

/** Constants of the VDA 5050 v2.0.0 interface that this project uses. */
public final class Vda {
    private Vda() {}
    public static final String VERSION = "2.0.0";

    public static final class ActionType {
        public static final String PICK = "pick";
        public static final String DROP = "drop";
        public static final String START_CHARGING = "startCharging";
        public static final String STOP_CHARGING = "stopCharging";
        public static final String CANCEL_ORDER = "cancelOrder";
        public static final String START_PAUSE = "startPause";
        public static final String STOP_PAUSE = "stopPause";
        public static final String STATE_REQUEST = "stateRequest";
        private ActionType() {}
    }

    public static final class Blocking {
        public static final String NONE = "NONE", SOFT = "SOFT", HARD = "HARD";
        private Blocking() {}
    }

    public static final class ActionStatus {
        public static final String WAITING = "WAITING", INITIALIZING = "INITIALIZING", RUNNING = "RUNNING",
                PAUSED = "PAUSED", FINISHED = "FINISHED", FAILED = "FAILED";
        private ActionStatus() {}
    }

    public static final class ConnectionState {
        public static final String ONLINE = "ONLINE", OFFLINE = "OFFLINE", CONNECTIONBROKEN = "CONNECTIONBROKEN";
        private ConnectionState() {}
    }

    public static final class ErrorLevel {
        public static final String WARNING = "WARNING", FATAL = "FATAL";
        private ErrorLevel() {}
    }
}
