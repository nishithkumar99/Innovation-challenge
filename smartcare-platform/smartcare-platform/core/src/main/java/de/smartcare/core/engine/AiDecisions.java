package de.smartcare.core.engine;

import java.util.*;

/** Short log of decisions taken because of the demand forecast, shown on the AI Control page. */
final class AiDecisions {
    record Entry(long ts, String type, String text) {}
    private final Deque<Entry> log = new ArrayDeque<>();
    private final Map<String, Integer> counters = new LinkedHashMap<>(Map.of("PRE_POSITION", 0, "KEPT_READY", 0, "RELEASED_EARLY", 0));

    void add(long ts, String type, String text) {
        counters.merge(type, 1, Integer::sum);
        log.addFirst(new Entry(ts, type, text));
        while (log.size() > 12) log.removeLast();
    }
    List<Entry> recent() { return new ArrayList<>(log); }
    Map<String, Integer> counters() { return counters; }
}
