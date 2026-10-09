package de.smartcare.core.vda;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

/** JSON (de)serialisation of VDA messages: null fields are omitted, unknown fields ignored. */
public final class Codec {
    private final ObjectMapper mapper;

    public Codec() {
        this.mapper = new ObjectMapper()
                .setSerializationInclusion(JsonInclude.Include.NON_NULL)
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }

    public Codec(ObjectMapper configured) { this.mapper = configured.copy()
            .setSerializationInclusion(JsonInclude.Include.NON_NULL)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false); }

    public String toJson(Object o) {
        try { return mapper.writeValueAsString(o); } catch (Exception e) { throw new IllegalStateException(e); }
    }

    public <T> T fromJson(String json, Class<T> type) {
        try { return mapper.readValue(json, type); } catch (Exception e) { throw new IllegalArgumentException("Invalid " + type.getSimpleName() + ": " + e.getMessage(), e); }
    }

    public ObjectMapper mapper() { return mapper; }
}
