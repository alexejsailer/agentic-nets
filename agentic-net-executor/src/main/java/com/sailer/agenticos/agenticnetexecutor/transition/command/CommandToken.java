package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.Objects;

/**
 * Command token schema - produced by LLM/Agent transitions and consumed by Command transitions.
 *
 * Example token (inline result):
 * {
 *   "kind": "command",
 *   "id": "cmd-12345",
 *   "executor": "fs",
 *   "command": "readFile",
 *   "args": { "path": "/tmp/data.json", "encoding": "utf-8" },
 *   "expect": "json",
 *   "meta": { "correlationId": "abc-123", "priority": 1 }
 * }
 *
 * Example token (binary URN result):
 * {
 *   "kind": "command",
 *   "id": "cmd-001",
 *   "executor": "bash",
 *   "command": "exec",
 *   "args": { "command": "wkhtmltopdf input.html output.pdf", "outputFile": "output.pdf" },
 *   "expect": "binary",
 *   "resultAs": "binaryUrn",
 *   "blobStore": { "host": "http://localhost:8095", "idStrategy": "timestamp" }
 * }
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record CommandToken(
        String kind,        // Always "command"
        String id,          // Unique command identifier
        String executor,    // Target executor: "fs", "bash", "karaf", "mcp"
        String command,     // Command name within executor
        JsonNode args,      // Command arguments (flexible structure)
        String expect,      // Expected return format: "json", "text", "binary"
        JsonNode meta,      // Optional metadata (correlationId, priority, etc.) - JsonNode to handle stringified JSON
        String resultAs,    // Result format: "inline" (default) or "binaryUrn" (upload to BlobStore)
        JsonNode blobStore  // BlobStore configuration: { "host": "...", "idStrategy": "..." }
) {
    private static final Logger logger = LoggerFactory.getLogger(CommandToken.class);
    private static final ObjectMapper mapper = new ObjectMapper();

    @JsonCreator
    public CommandToken(
            @JsonProperty("kind") String kind,
            @JsonProperty("id") String id,
            @JsonProperty("executor") String executor,
            @JsonProperty("command") String command,
            @JsonProperty("args") JsonNode args,
            @JsonProperty("expect") String expect,
            @JsonProperty("meta") JsonNode meta,
            @JsonProperty("resultAs") String resultAs,
            @JsonProperty("blobStore") JsonNode blobStore
    ) {
        this.kind = kind != null ? kind : "command";
        this.id = Objects.requireNonNull(id, "Command token requires an id");
        this.executor = Objects.requireNonNull(executor, "Command token requires an executor");
        this.command = Objects.requireNonNull(command, "Command token requires a command");
        this.args = args;
        this.expect = expect != null ? expect : "json";
        this.meta = meta;
        this.resultAs = resultAs != null ? resultAs : "inline";
        this.blobStore = blobStore;
    }

    /**
     * Get meta as a Map, parsing from string if necessary.
     * Handles tokens where meta is stored as stringified JSON.
     */
    public Map<String, Object> getMetaAsMap() {
        if (meta == null || meta.isNull()) {
            return Map.of();
        }
        // If meta is a string, try to parse it as JSON
        if (meta.isTextual()) {
            String metaText = meta.asText();
            if (metaText != null && !metaText.isBlank() && metaText.startsWith("{")) {
                try {
                    return mapper.readValue(metaText, new TypeReference<Map<String, Object>>() {});
                } catch (Exception e) {
                    logger.warn("Failed to parse stringified meta as JSON: {}", e.getMessage());
                    return Map.of();
                }
            }
            return Map.of();
        }
        // If meta is already an object, convert it
        if (meta.isObject()) {
            try {
                return mapper.convertValue(meta, new TypeReference<Map<String, Object>>() {});
            } catch (Exception e) {
                logger.warn("Failed to convert meta to Map: {}", e.getMessage());
                return Map.of();
            }
        }
        return Map.of();
    }

    /**
     * Validate that this is a proper command token.
     */
    public boolean isValid() {
        return "command".equals(kind)
                && id != null && !id.isBlank()
                && executor != null && !executor.isBlank()
                && command != null && !command.isBlank();
    }

    /**
     * Get a metadata value by key.
     */
    public Object getMetaValue(String key) {
        Map<String, Object> metaMap = getMetaAsMap();
        return metaMap.get(key);
    }

    /**
     * Get correlation ID from metadata.
     */
    public String getCorrelationId() {
        Object value = getMetaValue("correlationId");
        return value != null ? value.toString() : null;
    }

    /**
     * Get priority from metadata (default 0).
     */
    public int getPriority() {
        Object value = getMetaValue("priority");
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        return 0;
    }

    /**
     * Check if this command should upload binary output to BlobStore.
     */
    public boolean isBinaryUrn() {
        return "binaryUrn".equalsIgnoreCase(resultAs);
    }

    /**
     * Get the BlobStore host URL.
     */
    public String getBlobStoreHost() {
        if (blobStore == null || blobStore.isNull()) {
            return null;
        }
        if (blobStore.isTextual()) {
            // Handle case where blobStore is just a host string
            return blobStore.asText();
        }
        if (blobStore.isObject() && blobStore.has("host")) {
            return blobStore.get("host").asText();
        }
        return null;
    }

    /**
     * Get the BlobStore ID strategy.
     */
    public String getBlobStoreIdStrategy() {
        if (blobStore == null || blobStore.isNull() || !blobStore.isObject()) {
            return "timestamp"; // default
        }
        if (blobStore.has("idStrategy")) {
            return blobStore.get("idStrategy").asText("timestamp");
        }
        return "timestamp";
    }

    /**
     * Get the output file path from args (used for binary upload).
     */
    public String getOutputFile() {
        if (args == null || args.isNull()) {
            return null;
        }
        // Handle stringified JSON
        JsonNode argsNode = args;
        if (args.isTextual()) {
            try {
                argsNode = mapper.readTree(args.asText());
            } catch (Exception e) {
                return null;
            }
        }
        if (argsNode.has("outputFile")) {
            return argsNode.get("outputFile").asText();
        }
        return null;
    }
}
