package de.smartcare.core.event;

/** Realtime message: same shape as the Angular {@code Envelope}. {@code seq} increases by one for every message. */
public record Envelope(String topic, long seq, long ts, Object payload) {}
