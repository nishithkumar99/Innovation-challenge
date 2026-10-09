package de.smartcare.core.model;

import java.util.Set;

/** A named area. Restricted zones are excluded from routing unless a mission explicitly targets them. */
public record Zone(String id, String name, Set<String> nodeIds, Set<String> edgeIds, boolean restricted) {}
