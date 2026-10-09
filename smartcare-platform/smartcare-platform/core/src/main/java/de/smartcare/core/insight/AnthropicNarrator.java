package de.smartcare.core.insight;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import de.smartcare.core.settings.Settings;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * Optional LLM narrator (Anthropic Messages API). The model only rewrites an already detected finding into one plain
 * sentence – it has no tools and no influence on dispatching, charging or traffic decisions.
 */
public final class AnthropicNarrator implements Narrator {
    private final Settings.Llm cfg;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final ObjectMapper mapper = new ObjectMapper();

    public AnthropicNarrator(Settings.Llm cfg) { this.cfg = cfg; }

    @Override public String narrate(String category, String ruleBasedText, String facts) {
        try {
            Map<String, Object> body = Map.of(
                    "model", cfg.model,
                    "max_tokens", cfg.maxTokens,
                    "system", "You write one short, calm, plain-language sentence (max 30 words) for hospital staff about a delay in the "
                            + "robot delivery system. No jargon, no robot ids unless useful, no promises, no instructions to operate machines.",
                    "messages", List.of(Map.of("role", "user", "content",
                            "Category: " + category + "\nTechnical finding: " + ruleBasedText + "\nFacts: " + facts)));
            HttpRequest req = HttpRequest.newBuilder(URI.create(cfg.endpoint))
                    .timeout(Duration.ofMillis(cfg.timeoutMs))
                    .header("content-type", "application/json")
                    .header("x-api-key", cfg.apiKey)
                    .header("anthropic-version", "2023-06-01")
                    .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) return null;
            JsonNode root = mapper.readTree(res.body());
            JsonNode text = root.path("content").path(0).path("text");
            return text.isMissingNode() ? null : text.asText().trim();
        } catch (Exception e) {
            return null;
        }
    }
}
