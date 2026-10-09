package de.smartcare.core.anomaly;

/** Online mean/variance (Welford) used for z-score anomaly detection. */
public final class Welford {
    private long n; private double mean, m2;
    public void add(double x) { n++; double d = x - mean; mean += d / n; m2 += d * (x - mean); }
    public long count() { return n; }
    public double mean() { return mean; }
    public double std() { return n > 1 ? Math.sqrt(m2 / (n - 1)) : 0; }
    /** z-score of x against the history (0 if there is not enough data or no spread). */
    public double z(double x) { double s = std(); return s < 1e-9 ? 0 : (x - mean) / s; }
}
