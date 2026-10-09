package de.smartcare.core.api;

import de.smartcare.core.engine.CoreEngine;
import de.smartcare.core.event.Dto;
import de.smartcare.core.task.Task;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Framework-free application service behind the REST controllers: authorisation, idempotency and delegation to the core. */
public final class Api {
    private final CoreEngine core;
    private final Map<String, String> idempotentTasks = new ConcurrentHashMap<>();
    private final Map<String, String> tickets = new ConcurrentHashMap<>();
    private final List<String> audit = Collections.synchronizedList(new ArrayList<>());

    public Api(CoreEngine core) { this.core = core; }

    public CoreEngine core() { return core; }

    // ───── tasks ─────
    public String createTask(User u, Dto.TaskRequest req, String idempotencyKey) {
        require(u, "task:create");
        if (req == null || req.from() == null || req.to() == null || req.priority() == null) throw ApiException.badRequest("from, to and priority are required");
        if (idempotencyKey != null) {
            String existing = idempotentTasks.get(u.id() + "/" + idempotencyKey);
            if (existing != null) return existing;
        }
        // staff may only request STAT when their role allows; keep simple: anybody with task:create may choose any priority
        Task.Priority p;
        try { p = Task.Priority.valueOf(req.priority()); } catch (IllegalArgumentException e) { throw ApiException.badRequest("Unknown priority " + req.priority()); }
        String origin = "SIMULATED".equals(req.origin()) ? "SIMULATED" : "REAL";
        if ("SIMULATED".equals(origin)) require(u, "simulation:run");
        String id;
        try {
            id = core.createTask(req.source() == null ? "WARD" : req.source(), req.from(), req.to(), p.name(), req.item() == null ? "Item" : req.item(), req.notes(), origin, u.id(), u.name());
        } catch (IllegalArgumentException e) { throw ApiException.badRequest(e.getMessage()); }
        if (idempotencyKey != null) idempotentTasks.put(u.id() + "/" + idempotencyKey, id);
        audit(u, "createTask " + id);
        return id;
    }

    public Dto.ValidationResult validateTask(User u, Dto.TaskRequest req) {
        require(u, "task:create");
        return core.validateTask(req.from(), req.to(), req.priority());
    }

    // ───── commands ─────
    public String command(User u, Dto.CommandRequest cmd, String correlationId) {
        if (cmd == null || cmd.type() == null) throw ApiException.badRequest("type is required");
        String perm = Rbac.permissionFor(cmd.type());
        if (perm.equals("task:cancel:own")) {
            Task t = core.task(cmd.targetId());
            boolean own = t != null && t.requester.equals(u.id()) && u.can("task:cancel:own");
            if (!own && !u.can("task:modify:any")) throw ApiException.forbidden("You may only cancel your own requests");
        } else require(u, perm);
        String id = correlationId != null && !correlationId.isBlank() ? correlationId : UUID.randomUUID().toString();
        audit(u, cmd.type() + " " + cmd.targetId());
        core.command(cmd, id, u.id());
        return id;
    }

    public String applyInsight(User u, String insightId, String correlationId) {
        require(u, "insight:act");
        String id = correlationId != null ? correlationId : UUID.randomUUID().toString();
        audit(u, "applyInsight " + insightId);
        core.applyInsight(insightId, id, u.id());
        return id;
    }
    public void dismissInsight(User u, String id) { require(u, "insight:act"); audit(u, "dismissInsight " + id); core.dismissInsight(id); }
    public void acknowledgeInsight(User u, String id) { require(u, "insight:act"); core.acknowledgeInsight(id); }

    // ───── reads ─────
    public Dto.Snapshot snapshot(User u) { require(u, "fleet:view"); return new Scope(u).filter(core.snapshot()); }
    public List<Dto.KpiPoint> kpiSeries(User u, String window) { require(u, "kpi:view:basic"); return core.kpiSeries(window); }
    public Map<String, Object> diagnostics(User u) { require(u, "fleet:view:full"); return core.diagnostics(); }
    public Map<String, Object> intel(User u) { require(u, "fleet:view:full"); return core.intel(); }
    public List<String> audit(User u) { require(u, "audit:view"); return List.copyOf(audit); }

    // ───── websocket tickets (short-lived, single use) ─────
    public String issueTicket(User u) {
        String t = UUID.randomUUID().toString().replace("-", "");
        tickets.put(t, u.id());
        if (tickets.size() > 1000) tickets.clear();
        return t;
    }
    public User redeemTicket(String ticket) {
        String uid = ticket == null ? null : tickets.remove(ticket);
        return uid == null ? null : Rbac.DEMO_USERS.get(uid);
    }

    private void require(User u, String perm) {
        if (u == null) throw new ApiException(401, "Authentication required");
        if (!u.can(perm)) throw ApiException.forbidden("Missing permission " + perm);
    }
    private void audit(User u, String what) { audit.add(java.time.Instant.now() + " " + u.id() + " " + what); if (audit.size() > 2000) audit.remove(0); }
}
