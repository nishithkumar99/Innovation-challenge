package de.smartcare.core.mqtt;

import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BiConsumer;

/** Real MQTT 3.1.1 client (Eclipse Paho) with automatic reconnect; re-subscribes after every reconnect. */
public final class PahoMqttGateway implements MqttGateway {
    private record Sub(String filter, int qos, BiConsumer<String, String> handler) {}
    private final String uri, clientId, username, password;
    private final List<Sub> subs = new CopyOnWriteArrayList<>();
    private MqttClient client;
    /**
     * Paho's callback thread must never block: it also completes our own publish/subscribe calls, so handling messages on it
     * (the handlers take the core lock) can deadlock the client. Incoming messages are therefore handed to one worker thread
     * (keeps per-client ordering); re-subscribing after a reconnect runs there too.
     */
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "mqtt-worker"); t.setDaemon(true); return t; });

    public PahoMqttGateway(String host, int port, String clientId) { this(host, port, clientId, "", ""); }

    public PahoMqttGateway(String host, int port, String clientId, String username, String password) {
        this.uri = "tcp://" + host + ":" + port; this.clientId = clientId; this.username = username; this.password = password;
    }

    @Override public void start() throws MqttException {
        client = new MqttClient(uri, clientId, new MemoryPersistence());
        MqttConnectOptions o = new MqttConnectOptions();
        o.setAutomaticReconnect(true);
        o.setCleanSession(true);
        o.setConnectionTimeout(10);
        o.setKeepAliveInterval(30);
        if (username != null && !username.isBlank()) { o.setUserName(username); o.setPassword(password == null ? new char[0] : password.toCharArray()); }
        client.setCallback(new MqttCallbackExtended() {
            public void connectComplete(boolean reconnect, String serverURI) { if (reconnect) worker.execute(() -> resubscribe()); }
            public void connectionLost(Throwable cause) { System.err.println("MQTT connection lost (auto-reconnect is on): " + cause); }
            public void messageArrived(String topic, MqttMessage m) {
                String p = new String(m.getPayload(), StandardCharsets.UTF_8);
                worker.execute(() -> {
                    for (Sub s : subs) if (LoopbackBroker.matches(s.filter, topic)) {
                        try { s.handler.accept(topic, p); } catch (RuntimeException e) { System.err.println("MQTT handler error on " + topic + ": " + e); }
                    }
                });
            }
            public void deliveryComplete(IMqttDeliveryToken t) {}
        });
        client.connect(o);
    }

    private void resubscribe() {
        for (Sub s : subs) try { client.subscribe(s.filter, s.qos); } catch (MqttException e) { System.err.println("MQTT resubscribe failed: " + e); }
    }

    @Override public void publish(String topic, String payload, int qos, boolean retained) {
        try { client.publish(topic, payload.getBytes(StandardCharsets.UTF_8), qos, retained); }
        catch (MqttException e) { System.err.println("MQTT publish failed on " + topic + ": " + e.getMessage()); }
    }

    @Override public void subscribe(String filter, int qos, BiConsumer<String, String> handler) {
        subs.add(new Sub(filter, qos, handler));
        try { if (client != null && client.isConnected()) client.subscribe(filter, qos); } catch (MqttException e) { throw new IllegalStateException(e); }
    }

    @Override public boolean isConnected() { return client != null && client.isConnected(); }

    @Override public void close() { worker.shutdownNow(); try { if (client != null) { client.disconnect(); client.close(); } } catch (MqttException ignored) {} }
}
