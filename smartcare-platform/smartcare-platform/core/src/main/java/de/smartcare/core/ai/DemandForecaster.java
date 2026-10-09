package de.smartcare.core.ai;

import java.util.*;

/**
 * Online-learning demand model (no external service, no training phase). For every pickup station it learns how many
 * transport orders arrive per time bucket from two signals:
 * <ul>
 *   <li>a <b>level</b> – exponentially smoothed recent arrivals (reacts within minutes),</li>
 *   <li>a <b>daily profile</b> – exponentially smoothed arrivals per hour of the day (learns rush hours over days).</li>
 * </ul>
 * The forecast is a blend of both. At the end of every bucket the model compares its forecast with what really happened
 * and keeps its error (MAE), next to a naive "same as last bucket" baseline so the benefit is measurable.
 * Framework free; the clock is passed in so it is testable on virtual time.
 */
public final class DemandForecaster {
    public record Point(long ts, double actual, double predicted) {}

    private static final double LEVEL_ALPHA = 0.25, SEASON_ALPHA = 0.12, SEASON_WEIGHT = 0.4;
    private final long bucketMs;
    private final int minBuckets;
    private final Map<String, Double> level = new LinkedHashMap<>();
    private final Map<String, double[]> season = new HashMap<>();          // 24 hourly values per station
    private final Map<String, boolean[]> seasonSeen = new HashMap<>();
    private final Map<String, Integer> counts = new HashMap<>();           // arrivals in the open bucket
    private final Map<String, Double> bucketForecast = new HashMap<>();    // forecast made when the bucket opened
    private final Deque<Point> history = new ArrayDeque<>();
    private long bucketStart = -1;
    private int closed;
    private double absErr, absErrNaive, lastActual = Double.NaN;
    private int scored;

    public DemandForecaster(double bucketSeconds, int minBuckets) {
        this.bucketMs = Math.max(1000, (long) (bucketSeconds * 1000));
        this.minBuckets = minBuckets;
    }

    /** An order was requested at this pickup station. */
    public synchronized void record(String station, long now) {
        advance(now);
        counts.merge(station, 1, Integer::sum);
        level.putIfAbsent(station, 0.0);
    }

    /** Closes finished buckets (learning step). Call regularly. */
    public synchronized void advance(long now) {
        if (bucketStart < 0) { bucketStart = now - now % bucketMs; snapshotForecast(now); return; }
        int guard = 0;
        while (now - bucketStart >= bucketMs && guard++ < 1440) {
            closeBucket(bucketStart);
            bucketStart += bucketMs;
            snapshotForecast(bucketStart);
        }
        if (guard >= 1440) bucketStart = now - now % bucketMs;
    }

    private void snapshotForecast(long at) {
        bucketForecast.clear();
        for (String s : level.keySet()) bucketForecast.put(s, rate(s, at));
    }

    private void closeBucket(long start) {
        double actualTotal = 0, predTotal = 0;
        for (String s : level.keySet()) {
            double a = counts.getOrDefault(s, 0);
            actualTotal += a;
            predTotal += bucketForecast.getOrDefault(s, 0.0);
            boolean first = !seasonSeen.containsKey(s);
            double l = level.get(s);
            level.put(s, closed == 0 || (first && l == 0 && a > 0) ? a : LEVEL_ALPHA * a + (1 - LEVEL_ALPHA) * l);
            int h = hour(start);
            double[] sv = season.computeIfAbsent(s, k -> new double[24]);
            boolean[] ss = seasonSeen.computeIfAbsent(s, k -> new boolean[24]);
            sv[h] = ss[h] ? SEASON_ALPHA * a + (1 - SEASON_ALPHA) * sv[h] : a;
            ss[h] = true;
        }
        if (!level.isEmpty()) {
            if (!Double.isNaN(lastActual) && closed >= 1) { absErr += Math.abs(actualTotal - predTotal); absErrNaive += Math.abs(actualTotal - lastActual); scored++; }
            lastActual = actualTotal;
            closed++;
            history.addLast(new Point(start + bucketMs, actualTotal, predTotal));
            while (history.size() > 60) history.removeFirst();
        }
        counts.clear();
    }

    /** Forecast arrivals per bucket for this station in the bucket starting at {@code at}. */
    private double rate(String station, long at) {
        double l = level.getOrDefault(station, 0.0);
        double[] sv = season.get(station);
        boolean[] ss = seasonSeen.get(station);
        int h = hour(at);
        return sv != null && ss[h] ? (1 - SEASON_WEIGHT) * l + SEASON_WEIGHT * sv[h] : l;
    }

    /** Expected number of orders at {@code station} within the next {@code minutes}. */
    public synchronized double expected(String station, long now, double minutes) {
        advance(now);
        return rate(station, now) * (minutes * 60000.0 / bucketMs);
    }

    public synchronized double expectedTotal(long now, double minutes) {
        advance(now);
        double sum = 0;
        for (String s : level.keySet()) sum += rate(s, now) * (minutes * 60000.0 / bucketMs);
        return sum;
    }

    public synchronized Map<String, Double> perStation(long now, double minutes) {
        advance(now);
        Map<String, Double> m = new LinkedHashMap<>();
        for (String s : level.keySet()) m.put(s, rate(s, now) * (minutes * 60000.0 / bucketMs));
        return m;
    }

    /** True once enough buckets have been observed for the forecast to be trusted. */
    public synchronized boolean ready() { return closed >= minBuckets; }
    public synchronized int trainedBuckets() { return closed; }
    public synchronized double mae() { return scored == 0 ? 0 : absErr / scored; }
    public synchronized double naiveMae() { return scored == 0 ? 0 : absErrNaive / scored; }
    public synchronized List<Point> history() { return new ArrayList<>(history); }
    public long bucketSeconds() { return bucketMs / 1000; }

    private static int hour(long ts) { return (int) ((ts / 3_600_000L) % 24); }
}
