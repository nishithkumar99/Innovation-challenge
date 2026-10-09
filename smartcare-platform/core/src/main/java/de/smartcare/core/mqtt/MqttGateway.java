package de.smartcare.core.mqtt;

import java.util.function.BiConsumer;

/** Minimal publish/subscribe abstraction so the core runs against an embedded loopback broker or a real MQTT broker. */
public interface MqttGateway extends AutoCloseable {
    void start() throws Exception;
    void publish(String topic, String payload, int qos, boolean retained);
    /** Subscribes to a topic filter (supports + and #). Handler receives (topic, payload). */
    void subscribe(String filter, int qos, BiConsumer<String, String> handler);
    boolean isConnected();
    @Override void close();
}
