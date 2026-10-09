package de.smartcare.core.event;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Sequenced in-process event bus; the WebSocket layer subscribes and fans out to browsers. Call under the core lock. */
public final class EventBus {
    private final List<Consumer<Envelope>> listeners = new CopyOnWriteArrayList<>();
    private final LongSupplier now;
    private long seq;

    public EventBus(LongSupplier now) { this.now = now; }
    public long seq() { return seq; }
    public void subscribe(Consumer<Envelope> l) { listeners.add(l); }
    public void unsubscribe(Consumer<Envelope> l) { listeners.remove(l); }

    public Envelope publish(String topic, Object payload) {
        Envelope e = new Envelope(topic, ++seq, now.getAsLong(), payload);
        for (Consumer<Envelope> l : listeners) { try { l.accept(e); } catch (RuntimeException ex) { System.err.println("listener failed: " + ex); } }
        return e;
    }
}
