package de.smartcare.core.traffic;

import java.util.*;

/** Finds cycles in the wait-for graph (robot A waits for a resource held by robot B, ...). */
public final class DeadlockDetector {
    private DeadlockDetector() {}

    /** Returns every distinct cycle (as ordered robot lists). A cycle means no member can ever proceed on its own. */
    public static List<List<String>> cycles(Map<String, Set<String>> waitsFor) {
        List<List<String>> result = new ArrayList<>();
        Set<String> seenCycles = new HashSet<>();
        for (String start : waitsFor.keySet()) dfs(start, start, waitsFor, new ArrayList<>(List.of(start)), new HashSet<>(Set.of(start)), result, seenCycles);
        return result;
    }

    private static void dfs(String start, String cur, Map<String, Set<String>> g, List<String> path, Set<String> onPath,
                            List<List<String>> out, Set<String> seen) {
        for (String next : g.getOrDefault(cur, Set.of())) {
            if (next.equals(start)) {
                List<String> key = new ArrayList<>(path);
                Collections.sort(key);
                if (seen.add(String.join(",", key))) out.add(List.copyOf(path));
            } else if (!onPath.contains(next) && g.containsKey(next)) {
                path.add(next); onPath.add(next);
                dfs(start, next, g, path, onPath, out, seen);
                path.remove(path.size() - 1); onPath.remove(next);
            }
        }
    }
}
