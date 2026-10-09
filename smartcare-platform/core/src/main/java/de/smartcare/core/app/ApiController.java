package de.smartcare.core.app;

import de.smartcare.core.api.Api;
import de.smartcare.core.api.ApiException;
import de.smartcare.core.api.Rbac;
import de.smartcare.core.api.User;
import de.smartcare.core.event.Dto;
import de.smartcare.core.model.HospitalMap;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/** HTTP mapping only – all rules live in {@link Api}. Paths are the ones the Angular HttpFleetRestApi calls. */
@RestController
@RequestMapping("/api")
@ConditionalOnProperty(name = "smartcare.core.enabled", havingValue = "true", matchIfMissing = true)
public class ApiController {
    private final Api api;
    private final HospitalMap map;
    private final String externalKey;
    private final de.smartcare.core.settings.Settings settings;

    public ApiController(Api api, HospitalMap map, de.smartcare.core.settings.Settings settings) {
        this.api = api; this.map = map; this.settings = settings; this.externalKey = settings.core.externalApiKey;
    }

    private static User user(String authorization) {
        User u = Rbac.fromDevToken(authorization);
        if (u == null) throw new ApiException(401, "Missing or invalid Authorization header (dev: 'Bearer mock.<userId>')");
        return u;
    }

    // ───── tasks ─────
    @PostMapping("/tasks")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, String> createTask(@RequestHeader(value = "Authorization", required = false) String auth,
                                          @RequestHeader(value = "Idempotency-Key", required = false) String key,
                                          @RequestBody Dto.TaskRequest body) {
        return Map.of("taskId", api.createTask(user(auth), body, key));
    }

    @PostMapping("/tasks:validate")
    public Dto.ValidationResult validate(@RequestHeader(value = "Authorization", required = false) String auth, @RequestBody Dto.TaskRequest body) {
        return api.validateTask(user(auth), body);
    }

    // ───── commands (asynchronous: terminal state arrives as commands.acks on the WebSocket) ─────
    @PostMapping("/tasks/{id}/commands")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Map<String, String> taskCommand(@RequestHeader(value = "Authorization", required = false) String auth,
                                           @RequestHeader(value = "X-Correlation-Id", required = false) String cid,
                                           @PathVariable String id, @RequestBody Dto.CommandRequest cmd) {
        return Map.of("correlationId", api.command(user(auth), withTarget(cmd, id), cid));
    }

    @PostMapping("/robots/{id}/commands")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Map<String, String> robotCommand(@RequestHeader(value = "Authorization", required = false) String auth,
                                            @RequestHeader(value = "X-Correlation-Id", required = false) String cid,
                                            @PathVariable String id, @RequestBody Dto.CommandRequest cmd) {
        return Map.of("correlationId", api.command(user(auth), withTarget(cmd, id), cid));
    }

    @PostMapping("/zones/{id}/commands")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Map<String, String> zoneCommand(@RequestHeader(value = "Authorization", required = false) String auth,
                                           @RequestHeader(value = "X-Correlation-Id", required = false) String cid,
                                           @PathVariable String id, @RequestBody Dto.CommandRequest cmd) {
        return Map.of("correlationId", api.command(user(auth), withTarget(cmd, id), cid));
    }

    @PostMapping("/fleet/commands")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Map<String, String> fleetCommand(@RequestHeader(value = "Authorization", required = false) String auth,
                                            @RequestHeader(value = "X-Correlation-Id", required = false) String cid,
                                            @RequestBody Dto.CommandRequest cmd) {
        return Map.of("correlationId", api.command(user(auth), cmd, cid));
    }

    private static Dto.CommandRequest withTarget(Dto.CommandRequest c, String id) {
        return new Dto.CommandRequest(c.type(), id, c.params(), c.reason(), c.expectedVersion());
    }

    // ───── insights ─────
    @PostMapping("/insights/{id}/apply")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Map<String, String> apply(@RequestHeader(value = "Authorization", required = false) String auth,
                                     @RequestHeader(value = "Idempotency-Key", required = false) String key, @PathVariable String id) {
        return Map.of("correlationId", api.applyInsight(user(auth), id, key));
    }

    @PostMapping("/insights/{id}/dismiss")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void dismiss(@RequestHeader(value = "Authorization", required = false) String auth, @PathVariable String id) { api.dismissInsight(user(auth), id); }

    @PostMapping("/insights/{id}/acknowledge")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void acknowledge(@RequestHeader(value = "Authorization", required = false) String auth, @PathVariable String id) { api.acknowledgeInsight(user(auth), id); }

    // ───── reads ─────
    @GetMapping("/fleet/snapshot")
    public Dto.Snapshot snapshot(@RequestHeader(value = "Authorization", required = false) String auth) { return api.snapshot(user(auth)); }

    @GetMapping("/kpi/series")
    public List<Dto.KpiPoint> kpi(@RequestHeader(value = "Authorization", required = false) String auth, @RequestParam(defaultValue = "HOUR") String window) {
        return api.kpiSeries(user(auth), window);
    }

    @GetMapping("/intel")
    public Map<String, Object> intel(@RequestHeader(value = "Authorization", required = false) String auth) { return api.intel(user(auth)); }

    @GetMapping("/diagnostics")
    public Map<String, Object> diagnostics(@RequestHeader(value = "Authorization", required = false) String auth) { return api.diagnostics(user(auth)); }

    @GetMapping("/audit")
    public List<String> audit(@RequestHeader(value = "Authorization", required = false) String auth) { return api.audit(user(auth)); }

    /** Static navigation graph, handy for tools that want to draw the same map. */
    @GetMapping("/fleet/map")
    public Map<String, Object> map() {
        List<Map<String, Object>> nodes = new ArrayList<>(), edges = new ArrayList<>();
        map.nodes().forEach(n -> nodes.add(Map.of("id", n.id(), "name", n.name(), "x", n.x(), "y", n.y(), "kind", n.kind().name(), "capacity", n.capacity())));
        map.edges().forEach(e -> edges.add(Map.of("id", e.id(), "a", e.a(), "b", e.b(), "length", e.length())));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("mapId", settings.mqtt.mapId);
        out.put("width", map.width());
        out.put("height", map.height());
        out.put("background", settings.map.backgroundImage);
        out.put("nodes", nodes);
        out.put("edges", edges);
        return out;
    }

    // ───── websocket ticket ─────
    @PostMapping("/ws/ticket")
    public Map<String, String> ticket(@RequestHeader(value = "Authorization", required = false) String auth) { return Map.of("ticket", api.issueTicket(user(auth))); }

    // ───── adapter point for the organisers' task interface ─────
    /**
     * Placeholder for the "predefined REST interface" through which the organisers' system hands over transport orders.
     * Their exact schema is not known yet: map it to {@code Dto.TaskRequest} here (or add a second controller) once it is published.
     */
    @PostMapping("/external/transport-orders")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, String> external(@RequestHeader(value = "X-Api-Key", required = false) String key, @RequestBody Dto.TaskRequest body) {
        if (!externalKey.isBlank() && !externalKey.equals(key)) throw new ApiException(401, "Invalid X-Api-Key");
        User system = Rbac.DEMO_USERS.get("u-op");
        return Map.of("taskId", api.createTask(system, body, null));
    }

    // ───── errors ─────
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> onApi(ApiException e) { return ResponseEntity.status(e.status).body(Map.of("error", e.getMessage(), "status", e.status)); }

    @ExceptionHandler({IllegalArgumentException.class, org.springframework.http.converter.HttpMessageNotReadableException.class})
    public ResponseEntity<Map<String, Object>> onBad(Exception e) { return ResponseEntity.badRequest().body(Map.of("error", String.valueOf(e.getMessage()), "status", 400)); }
}
