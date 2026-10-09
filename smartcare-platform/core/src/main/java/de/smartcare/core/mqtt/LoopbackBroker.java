package de.smartcare.core.mqtt;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BiConsumer;

/** In-process MQTT-like broker (topic filters with + and #, retained messages). Used for INTERNAL mode and tests. */
public final class LoopbackBroker {
    private record Sub(String filter, BiConsumer<String, String> handler) {}
    private final List<Sub> subs = new CopyOnWriteArrayList<>();
    private final Map<String, String> retained = new ConcurrentHashMap<>();

    public void publish(String topic, String payload, boolean retain) {
        if (retain) { if (payload == null || payload.isEmpty()) retained.remove(topic); else retained.put(topic, payload); }
        for (Sub s : subs) if (matches(s.filter, topic)) deliver(s, topic, payload);
    }

    public void subscribe(String filter, BiConsumer<String, String> handler) {
        Sub s = new Sub(filter, handler);
        subs.add(s);
        retained.forEach((t, p) -> { if (matches(filter, t)) deliver(s, t, p); });
    }

    private void deliver(Sub s, String topic, String payload) {
        try { s.handler.accept(topic, payload); } catch (RuntimeException e) { System.err.println("MQTT handler error on " + topic + ": " + e); }
    }

    public static boolean matches(String filter, String topic) {
        String[] f = filter.split("/", -1), t = topic.split("/", -1);
        for (int i = 0; i < f.length; i++) {
            if (f[i].equals("#")) return true;
            if (i >= t.length) return false;
            if (!f[i].equals("+") && !f[i].equals(t[i])) return false;
        }
        return f.length == t.length;
    }

    /** A gateway attached to this broker. */
    public MqttGateway gateway() {
        return new MqttGateway() {
            public void start() {}
            public void publish(String topic, String payload, int qos, boolean retained) { LoopbackBroker.this.publish(topic, payload, retained); }
            public void subscribe(String filter, int qos, BiConsumer<String, String> h) { LoopbackBroker.this.subscribe(filter, h); }
            public boolean isConnected() { return true; }
            public void close() {}
        };
    }
}
