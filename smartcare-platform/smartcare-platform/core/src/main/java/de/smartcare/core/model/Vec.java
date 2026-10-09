package de.smartcare.core.model;

public record Vec(double x, double y) {
    public double dist(Vec o) { return Math.hypot(x - o.x, y - o.y); }
}
