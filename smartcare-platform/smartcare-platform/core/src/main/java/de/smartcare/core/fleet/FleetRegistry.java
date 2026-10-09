package de.smartcare.core.fleet;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/** All robots the core has seen on MQTT, keyed by serial number. */
public final class FleetRegistry {
    private final Map<String, Robot> robots = new LinkedHashMap<>();

    public Robot getOrCreate(String manufacturer, String serial, long now) {
        return robots.computeIfAbsent(serial, s -> new Robot(manufacturer, s, now));
    }
    public Robot get(String serial) { return robots.get(serial); }
    public Collection<Robot> all() { return robots.values(); }
}
