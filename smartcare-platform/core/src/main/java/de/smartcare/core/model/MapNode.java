package de.smartcare.core.model;

/** A navigation node. {@code capacity} = how many vehicles may occupy/reserve it at once. */
public record MapNode(String id, String name, double x, double y, NodeKind kind, int capacity) {
    public Vec pos() { return new Vec(x, y); }
    public boolean isStation() { return kind != NodeKind.JUNCTION; }
    public boolean isCharger() { return kind == NodeKind.CHARGING; }
}
