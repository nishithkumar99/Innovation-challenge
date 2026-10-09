package de.smartcare.core.api;

import java.util.*;

/** Role → permission matrix (identical to the Angular UI) and the demo user directory. */
public final class Rbac {
    private Rbac() {}

    private static final List<String> STAFF = List.of("task:create", "task:read:own", "task:cancel:own", "fleet:view", "insight:view");
    private static final List<String> LEAD = concat(STAFF, "task:read:dept", "kpi:view:basic");
    private static final List<String> OPERATOR = concat(LEAD, "task:read:all", "task:modify:any", "fleet:view:full", "insight:act", "override:robot", "override:estop", "simulation:run");
    private static final List<String> MANAGER = concat(OPERATOR, "override:fleet", "kpi:view:full", "audit:view");
    private static final List<String> ADMIN = concat(MANAGER, "config:manage");

    private static List<String> concat(List<String> a, String... b) { List<String> l = new ArrayList<>(a); l.addAll(Arrays.asList(b)); return l; }

    /** Demo personas (same ids as the UI). Replace by an OIDC/JWT resolver for production. */
    public static final Map<String, User> DEMO_USERS = Map.of(
            "u-staff", new User("u-staff", "Anna Keller", "STAFF", "Ward1_Hallway", Set.copyOf(STAFF)),
            "u-staff2", new User("u-staff2", "Sofia Rossi", "STAFF", "Ward2_Hallway", Set.copyOf(STAFF)),
            "u-staff3", new User("u-staff3", "Daniel Okafor", "STAFF", "OR_1_Hallway", Set.copyOf(STAFF)),
            "u-staff4", new User("u-staff4", "Mia Hoffmann", "STAFF", "OR_2_Hallway", Set.copyOf(STAFF)),
            "u-lead", new User("u-lead", "Markus Brandt", "DEPT_LEAD", "Ward2_Hallway", Set.copyOf(LEAD)),
            "u-op", new User("u-op", "Priya Nair", "OPERATOR", null, Set.copyOf(OPERATOR)),
            "u-mgr", new User("u-mgr", "Jonas Weber", "MANAGER", null, Set.copyOf(MANAGER)),
            "u-admin", new User("u-admin", "Sai (admin)", "ADMIN", null, Set.copyOf(ADMIN)));

    /** Resolves "Bearer mock.u-op" (dev) – returns null for anything else. */
    public static User fromDevToken(String authorizationHeader) {
        if (authorizationHeader == null) return null;
        String t = authorizationHeader.startsWith("Bearer ") ? authorizationHeader.substring(7) : authorizationHeader;
        if (!t.startsWith("mock.")) return null;
        return DEMO_USERS.get(t.substring(5));
    }

    /** Which permission a command needs. */
    public static String permissionFor(String commandType) {
        return switch (commandType) {
            case "ESTOP" -> "override:estop";
            case "FLEET_HOLD", "FLEET_RESUME", "SET_MODE", "BLOCK_ZONE", "UNBLOCK_ZONE" -> "override:fleet";
            case "REASSIGN", "SET_PRIORITY" -> "task:modify:any";
            case "CANCEL_TASK" -> "task:cancel:own";           // plus ownership check unless task:modify:any
            default -> "override:robot";
        };
    }
}
