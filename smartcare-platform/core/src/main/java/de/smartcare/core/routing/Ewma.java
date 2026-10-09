package de.smartcare.core.routing;

/** Exponentially weighted moving average with a sample counter. */
public final class Ewma {
    private final double alpha;
    private double value;
    private int n;

    public Ewma(double alpha) { this.alpha = alpha; }

    public synchronized void add(double x) {
        value = n == 0 ? x : alpha * x + (1 - alpha) * value;
        n++;
    }
    public synchronized double value(double fallback) { return n == 0 ? fallback : value; }
    public synchronized int count() { return n; }
}
