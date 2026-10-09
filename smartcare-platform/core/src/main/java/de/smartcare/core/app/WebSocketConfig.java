package de.smartcare.core.app;

import com.fasterxml.jackson.databind.ObjectMapper;
import de.smartcare.core.api.Api;
import de.smartcare.core.api.Scope;
import de.smartcare.core.api.User;
import de.smartcare.core.event.Envelope;
import de.smartcare.core.settings.Settings;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** CORS for the browser UI and the realtime WebSocket endpoint {@code /ws?ticket=...}. */
@Configuration
@EnableWebSocket
@ConditionalOnProperty(name = "smartcare.core.enabled", havingValue = "true", matchIfMissing = true)
public class WebSocketConfig implements WebSocketConfigurer, WebMvcConfigurer {
    private static final Logger log = LoggerFactory.getLogger(WebSocketConfig.class);
    private final Api api;
    private final ObjectMapper mapper;
    private final String[] origins;
    private final Map<String, Client> clients = new ConcurrentHashMap<>();

    /** One browser connection with its own bounded outbound queue, so a slow client can never block the control loop. */
    private static final class Client {
        final WebSocketSession session;
        final Scope scope;
        final BlockingQueue<String> queue = new LinkedBlockingQueue<>(2000);
        final AtomicBoolean draining = new AtomicBoolean();
        Client(WebSocketSession session, Scope scope) { this.session = session; this.scope = scope; }
    }

    private final ExecutorService senders = Executors.newFixedThreadPool(4, r -> { Thread t = new Thread(r, "ws-sender"); t.setDaemon(true); return t; });

    public WebSocketConfig(Api api, ObjectMapper mapper, Settings settings) {
        this.api = api; this.mapper = mapper;
        this.origins = settings.core.allowedOrigins.split("\\s*,\\s*");
        // single fan-out listener; runs under the core lock, so per-client Scope state needs no extra locking
        api.core().context().bus.subscribe(this::broadcast);
    }

    @Override public void addCorsMappings(CorsRegistry r) {
        r.addMapping("/api/**").allowedOrigins(origins).allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS").allowedHeaders("*").maxAge(3600);
    }

    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(new TextWebSocketHandler() {
            @Override public void afterConnectionEstablished(WebSocketSession session) throws Exception {
                String ticket = UriComponentsBuilder.fromUri(session.getUri()).build().getQueryParams().getFirst("ticket");
                User u = api.redeemTicket(ticket);
                if (u == null) { session.close(CloseStatus.POLICY_VIOLATION.withReason("invalid ticket")); return; }
                clients.put(session.getId(), new Client(new ConcurrentWebSocketSessionDecorator(session, 5_000, 512 * 1024), new Scope(u)));
                log.info("WebSocket connected: {} ({})", u.id(), session.getId());
            }
            @Override public void afterConnectionClosed(WebSocketSession session, CloseStatus status) { clients.remove(session.getId()); }
            @Override public void handleTransportError(WebSocketSession session, Throwable e) { clients.remove(session.getId()); }
        }, "/ws").setAllowedOrigins(origins);
    }

    /** Called under the core lock: only filters + serialises + enqueues (no network I/O here). */
    private void broadcast(Envelope e) {
        if (clients.isEmpty()) return;
        for (Client c : clients.values()) {
            try {
                String json = mapper.writeValueAsString(c.scope.filter(e));
                if (!c.queue.offer(json)) { drop(c, "outbound queue full"); continue; }
                if (c.draining.compareAndSet(false, true)) senders.execute(() -> drain(c));
            } catch (Exception ex) { drop(c, ex.toString()); }
        }
    }

    private void drain(Client c) {
        try {
            String m;
            while ((m = c.queue.poll()) != null) c.session.sendMessage(new TextMessage(m));
        } catch (Exception ex) {
            drop(c, ex.toString());
        } finally {
            c.draining.set(false);
            if (!c.queue.isEmpty() && c.draining.compareAndSet(false, true)) senders.execute(() -> drain(c));
        }
    }

    private void drop(Client c, String why) {
        if (clients.remove(c.session.getId()) != null) {
            log.warn("Dropping WebSocket client {}: {}", c.session.getId(), why);
            try { c.session.close(CloseStatus.SESSION_NOT_RELIABLE); } catch (Exception ignored) { }
        }
    }
}
