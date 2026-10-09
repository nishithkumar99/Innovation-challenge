package de.smartcare.core.api;

import java.util.Set;

/** An authenticated caller. In production this comes from OIDC claims; the dev profile maps "Bearer mock.<id>". */
public record User(String id, String name, String role, String department, Set<String> permissions) {
    public boolean can(String p) { return permissions.contains(p); }
    public boolean isOps() { return can("fleet:view:full"); }
}
