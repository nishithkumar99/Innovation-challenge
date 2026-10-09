package de.smartcare.core.engine;

import de.smartcare.core.fleet.Robot;
import de.smartcare.core.mission.Mission;
import de.smartcare.core.mission.Mission.Leg;
import de.smartcare.core.model.MapEdge;
import de.smartcare.core.model.MapNode;
import de.smartcare.core.routing.Path;
import de.smartcare.core.routing.RouteConstraints;
import de.smartcare.core.traffic.DeadlockDetector;

import java.util.*;

/**
 * Multi-AMR coordination. Vehicles only get the part of their route released (VDA 5050 "base") that the core has
 * reserved for them; the rest stays "horizon". Blocked vehicles form a wait-for graph; cycles are deadlocks and are
 * resolved by re-routing the vehicle with the lowest priority around the contested resource.
 */
final class TrafficController {
    record Deadlock(List<String> robots, String resolution, long detectedAt) {}

    private final Context c;
    private final MissionService missions;
    private final Map<String, Set<String>> waitsFor = new LinkedHashMap<>();
    private final Map<String, String> contested = new HashMap<>();   // robot -> node it is waiting to enter
    private final List<Deadlock> active = new ArrayList<>();
    private final Map<String, Long> lastReroute = new HashMap<>();
    private int deadlocksResolved;

    TrafficController(Context c, MissionService missions) { this.c = c; this.missions = missions; }

    List<Deadlock> activeDeadlocks() { return List.copyOf(active); }
    int deadlocksResolved() { return deadlocksResolved; }
    Map<String, Set<String>> waitGraph() { return waitsFor; }
    Map<String, String> contestedNodes() { return contested; }

    void tick() {
        waitsFor.clear();
        contested.clear();
        long now = c.now();
        for (Robot r : c.fleet.all()) {
            if (!r.online) continue;
            Mission m = r.mission;
            if (m == null || m.finished() || !m.current().sent) {
                // idle robots occupy exactly the node they stand on
                if (m == null) { c.reservations.releaseAllExcept(r.serial, c.occupiedNode(r)); }
                r.waitingOn = null;
                continue;
            }
            Leg leg = m.current();
            if (r.state == null || !leg.orderId.equals(r.state.orderId())) continue;

            // release what the robot has driven past
            for (int i = 0; i < leg.reachedIdx; i++) {
                c.reservations.releaseEdge(r.serial, c.map.edgeBetween(leg.path.get(i), leg.path.get(i + 1)).id());
                c.reservations.releaseNode(r.serial, leg.path.get(i));
            }
            if (r.manual || r.paused || r.estop || r.latched || c.hold) { continue; }

            // Before anything is reserved: the first stretch must be physically free. A vehicle that stands right in front (a row of
            // vehicles at start-up, or a vehicle that is waiting) would stop this one, and a reservation it cannot use only blocks others.
            Set<String> inFront = leg.releasedIdx == leg.reachedIdx ? standingInTheWay(r, leg) : Set.of();
            if (!inFront.isEmpty()) {
                contested.put(r.serial, leg.path.get(Math.min(leg.reachedIdx + 1, leg.path.size() - 1)));
                if (r.waitingOn == null) r.waitingSinceMs = now;
                r.waitingOn = inFront.iterator().next();
                waitsFor.put(r.serial, inFront);
                continue;
            }
            boolean whole = c.cfg.traffic.reserveWholeRoute;
            int target = whole ? leg.path.size() - 1 : Math.min(leg.path.size() - 1, leg.reachedIdx + c.cfg.traffic.lookaheadSegments);
            int old = leg.releasedIdx;
            Set<String> blockers = Set.of();
            while (leg.releasedIdx < target) {
                int k = leg.releasedIdx + 1;
                MapEdge e = c.map.edgeBetween(leg.path.get(k - 1), leg.path.get(k));
                if (c.router.isBlocked(e.id())) { blockers = Set.of("zone:" + e.id()); contested.put(r.serial, leg.path.get(k)); break; }
                blockers = c.reservations.tryReserve(r.serial, e.id(), leg.path.get(k));
                if (!blockers.isEmpty()) { contested.put(r.serial, leg.path.get(k)); break; }
                leg.releasedIdx = k;
            }
            if (whole && leg.releasedIdx < target && leg.releasedIdx > old) {
                // all or nothing: give back what was granted this round, so that a waiting vehicle holds nothing but its own node
                for (int k = old + 1; k <= leg.releasedIdx; k++) {
                    c.reservations.releaseEdge(r.serial, c.map.edgeBetween(leg.path.get(k - 1), leg.path.get(k)).id());
                    c.reservations.releaseNode(r.serial, leg.path.get(k));
                }
                leg.releasedIdx = old;
            }
            if (leg.releasedIdx > old) missions.sendUpdate(r, leg, old);

            // a neighbour standing in the way of a vehicle that is cleared to drive is a blocker the reservation table cannot see
            boolean physical = false;
            Set<String> inTheWay = physicalBlockers(r, leg, now);
            if (!inTheWay.isEmpty()) {
                Set<String> all = new LinkedHashSet<>(blockers); all.addAll(inTheWay);
                blockers = all; physical = true;
                if (!contested.containsKey(r.serial) && leg.reachedIdx + 1 < leg.path.size()) contested.put(r.serial, leg.path.get(leg.reachedIdx + 1));
            }
            boolean stuck = !blockers.isEmpty() && ((leg.releasedIdx == leg.reachedIdx && !r.driving) || physical);
            if (stuck) {
                if (r.waitingOn == null) r.waitingSinceMs = now;
                r.waitingOn = blockers.iterator().next();
                waitsFor.put(r.serial, blockers);
            } else r.waitingOn = null;
        }
        yieldToBlockedNeighbours(now);
        detectAndResolve();
    }

    /** Vehicles that are not moving and stand within collision distance of the straight line from {@code r} to the next node of its route. */
    private Set<String> standingInTheWay(Robot r, Leg leg) {
        double clearance = c.cfg.traffic.physicalClearanceM;
        if (clearance <= 0 || leg.reachedIdx + 1 >= leg.path.size()) return Set.of();
        MapNode next = c.map.node(leg.path.get(leg.reachedIdx + 1));
        if (next == null) return Set.of();
        double dx = next.x() - r.x, dy = next.y() - r.y, l2 = dx * dx + dy * dy;
        Set<String> out = new LinkedHashSet<>();
        for (Robot o : c.fleet.all()) {
            if (o == r || !o.online || o.driving) continue;
            double t = l2 == 0 ? 0 : Math.max(0, Math.min(1, ((o.x - r.x) * dx + (o.y - r.y) * dy) / l2));
            if (Math.hypot(o.x - (r.x + t * dx), o.y - (r.y + t * dy)) < clearance - 1e-6) out.add(o.serial);
        }
        return out;
    }

    private final Map<String, Long> lastYield = new HashMap<>();

    /** Vehicles that stand within collision distance of {@code r} while {@code r} is cleared to drive but has not moved for a while. */
    private Set<String> physicalBlockers(Robot r, Leg leg, long now) {
        double clearance = c.cfg.traffic.physicalClearanceM;
        if (clearance <= 0 || r.driving || leg.releasedIdx <= leg.reachedIdx) return Set.of();
        if (now - Math.max(r.lastMoveMs, leg.lastProgressMs) < c.cfg.traffic.yieldWaitS * 1000L) return Set.of();
        Set<String> out = new LinkedHashSet<>();
        for (Robot o : c.fleet.all()) if (o != r && o.online && Math.hypot(o.x - r.x, o.y - r.y) <= clearance + 0.05) out.add(o.serial);
        return out;
    }

    /**
     * Idle vehicles do not move on their own, so one that stands in somebody's way (on the node, on a node beside the corridor,
     * or right in front of the vehicle) is sent to a free node out of the way once the waiting vehicle has waited a moment.
     * Vehicles that are moving clear the way by themselves.
     */
    private void yieldToBlockedNeighbours(long now) {
        if (c.hold || !"AUTO".equals(c.mode)) return;
        for (var en : new ArrayList<>(waitsFor.entrySet())) {
            Robot r = c.fleet.get(en.getKey());
            if (r == null || r.mission == null || r.mission.finished() || now - r.waitingSinceMs < c.cfg.traffic.yieldWaitS * 1000L) continue;
            for (String b : en.getValue()) {
                Robot o = c.fleet.get(b);
                if (o == null || !o.online || o.manual || o.latched || o.mission != null || o.lastNodeId == null || o.state == null) continue;
                if (now - lastYield.getOrDefault(o.serial, 0L) < 10_000) continue;
                if (stepAside(o, r, r.mission.current())) lastYield.put(o.serial, now);
            }
        }
    }

    /** Sends the idle vehicle {@code o} to the nearest free node that is neither on {@code r}'s remaining route nor beside it. */
    private boolean stepAside(Robot o, Robot r, Leg leg) {
        Set<String> avoid = new HashSet<>();
        for (int i = Math.min(leg.reachedIdx, leg.path.size() - 1); i < leg.path.size(); i++) {
            avoid.add(leg.path.get(i));
            if (i + 1 < leg.path.size()) avoid.addAll(c.reservations.foulNodesOf(c.map.edgeBetween(leg.path.get(i), leg.path.get(i + 1)).id()));
        }
        String best = null; double bestT = Double.MAX_VALUE;
        for (MapNode n : c.map.nodes()) {
            if (avoid.contains(n.id()) || n.id().equals(o.lastNodeId) || n.isCharger() || c.reservations.nodeLoad(n.id()) > 0) continue;
            if (Math.hypot(n.x() - r.x, n.y() - r.y) < 2.0) continue;
            var p = c.router.shortest(o.lastNodeId, n.id(), RouteConstraints.NONE);
            if (p.isPresent() && p.get().timeS() < bestT) { bestT = p.get().timeS(); best = n.id(); }
        }
        if (best == null) return false;
        var plan = missions.planSingle(o, best, Mission.Type.GOTO, Mission.Role.GOTO);
        if (plan.isEmpty()) return false;
        missions.start(o, plan.get());
        return true;
    }

    private void detectAndResolve() {
        long now = c.now();
        active.removeIf(d -> d.robots.stream().noneMatch(s -> waitsFor.containsKey(s)) );
        // only robots that have been waiting for a while take part (short waits are normal queuing)
        Map<String, Set<String>> g = new LinkedHashMap<>();
        for (var en : waitsFor.entrySet()) {
            Robot r = c.fleet.get(en.getKey());
            if (r != null && now - r.waitingSinceMs >= c.cfg.traffic.deadlockMinWaitS * 1000L) g.put(en.getKey(), en.getValue());
        }
        for (List<String> cycle : DeadlockDetector.cycles(g)) {
            boolean known = active.stream().anyMatch(d -> d.robots.containsAll(cycle));
            if (known) continue;
            String resolution = "none";
            // optional trips (parking, positioning) never justify a deadlock: drop them first
            Robot optional = null;
            for (String s : cycle) { Robot o = c.fleet.get(s); if (o != null && o.mission != null && !o.mission.finished() && o.mission.taskId == null && o.mission.type == Mission.Type.GOTO) { optional = o; break; } }
            if (optional != null && "AUTO".equals(c.mode)) {
                missions.abandon(optional);
                resolution = "cancelled the optional trip of " + optional.serial;
                deadlocksResolved++;
            } else if (c.cfg.anomaly.autoResolveDeadlocks && "AUTO".equals(c.mode)) {
                for (String victim : byVictimOrder(cycle)) {
                    if (reroute(c.fleet.get(victim))) { resolution = "re-routed " + victim; deadlocksResolved++; break; }
                }
            } else resolution = "awaiting operator";
            active.add(new Deadlock(cycle, resolution, now));
        }
        // robots blocked by a vehicle that is idle/manual (never moves on its own) or by a blocked zone: re-route around it
        for (var en : waitsFor.entrySet()) {
            Robot r = c.fleet.get(en.getKey());
            if (now - r.waitingSinceMs < (en.getValue().stream().anyMatch(x -> x.startsWith("zone:")) ? 500 : c.cfg.traffic.deadlockMinWaitS * 1000L)) continue;
            for (String b : en.getValue()) {
                Robot other = c.fleet.get(b);
                if ((b.startsWith("zone:") || (other != null && (other.manual || other.mission == null))) && "AUTO".equals(c.mode) && c.cfg.anomaly.autoResolveDeadlocks) {
                    if (now - lastReroute.getOrDefault(r.serial, 0L) > 5000 && reroute(r)) deadlocksResolved++;
                }
            }
        }
    }

    /** Victim order: vehicles without cargo first, then lowest task priority, then least progress. */
    private List<String> byVictimOrder(List<String> cycle) {
        List<String> l = new ArrayList<>(cycle);
        l.sort(Comparator.comparingDouble((String s) -> score(c.fleet.get(s))).thenComparing(s -> s));
        return l;
    }

    private double score(Robot r) {
        double s = 0;
        Mission m = r.mission;
        if (m == null) return -1;
        if (m.current().role == Mission.Role.DROP) s += 1000;
        if (m.taskId != null && c.tasks.get(m.taskId) != null) s += c.tasks.get(m.taskId).priority.weight * 100;
        return s + m.current().reachedIdx;
    }

    /** Re-plans the remainder of the current leg around the node this robot is waiting for. */
    boolean reroute(Robot r) {
        Mission m = r.mission;
        if (m == null || m.finished()) return false;
        Leg leg = m.current();
        String blockedNode = contested.get(r.serial);
        if (blockedNode == null || leg.releasedIdx != leg.reachedIdx) return false;
        RouteConstraints rc = RouteConstraints.NONE.withNode(blockedNode);
        for (String n : c.standingNodes(r)) {
            rc = rc.withNode(n);
            for (String e : c.reservations.foulEdgesOf(n)) rc = rc.withEdge(e);
        }
        MapEdge be = c.map.edgeBetween(leg.path.get(leg.reachedIdx), blockedNode);
        if (be != null) rc = rc.withEdge(be.id());
        for (Deadlock d : active) for (String s : d.robots) { Robot o = c.fleet.get(s); if (o != null && !s.equals(r.serial)) rc = rc.withNode(o.lastNodeId); }
        Optional<Path> p = c.router.shortest(leg.path.get(leg.reachedIdx), leg.last(), rc);
        if (p.isEmpty() && be != null) p = c.router.shortest(leg.path.get(leg.reachedIdx), leg.last(), RouteConstraints.NONE.withEdge(be.id()));
        if (p.isEmpty()) return false;
        List<String> np = new ArrayList<>(leg.path.subList(0, leg.reachedIdx + 1));
        np.addAll(p.get().nodes().subList(1, p.get().nodes().size()));
        if (np.equals(leg.path)) return false;
        int old = leg.releasedIdx;
        leg.path = np;
        missions.sendUpdate(r, leg, old);
        lastReroute.put(r.serial, c.now());
        return true;
    }
}
