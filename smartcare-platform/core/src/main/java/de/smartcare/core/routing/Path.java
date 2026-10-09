package de.smartcare.core.routing;

import java.util.List;

/** A node path with its estimated travel time (seconds) and length (metres). */
public record Path(List<String> nodes, double timeS, double lengthM) {
    public String first() { return nodes.get(0); }
    public String last() { return nodes.get(nodes.size() - 1); }
}
