package de.smartcare.core.model;

/** An undirected corridor segment (one vehicle at a time). */
public record MapEdge(String id, String a, String b, double length, double maxSpeed) {
    public String other(String node) { return node.equals(a) ? b : a; }
}
