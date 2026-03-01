package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;

/**
 * Result of executing a single command.
 *
 * Example result:
 * {
 *   "id": "cmd-12345",
 *   "status": "success",
 *   "output": { "content": "file contents here..." },
 *   "error": null,
 *   "durationMs": 150,
 *   "meta": { "correlationId": "abc-123" }
 * }
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record CommandResult(
        String id,              // Original command ID
        Status status,          // Execution status
        JsonNode output,        // Command output (flexible structure)
        String error,           // Error message if failed
        Long durationMs,        // Execution duration in milliseconds
        Instant completedAt,    // Completion timestamp
        Map<String, Object> meta  // Metadata from original command + execution metadata
) {

    public enum Status {
        SUCCESS,    // Command completed successfully
        FAILED,     // Command failed with error
        TIMEOUT,    // Command timed out
        SKIPPED     // Command was skipped (e.g., duplicate)
    }

    @JsonCreator
    public CommandResult(
            @JsonProperty("id") String id,
            @JsonProperty("status") Status status,
            @JsonProperty("output") JsonNode output,
            @JsonProperty("error") String error,
            @JsonProperty("durationMs") Long durationMs,
            @JsonProperty("completedAt") Instant completedAt,
            @JsonProperty("meta") Map<String, Object> meta
    ) {
        this.id = Objects.requireNonNull(id, "Command result requires an id");
        this.status = status != null ? status : Status.FAILED;
        this.output = output;
        this.error = error;
        this.durationMs = durationMs;
        this.completedAt = completedAt != null ? completedAt : Instant.now();
        this.meta = meta != null ? Map.copyOf(meta) : Map.of();
    }

    /**
     * Create a success result.
     */
    public static CommandResult success(String id, JsonNode output, long durationMs, Map<String, Object> meta) {
        return new CommandResult(id, Status.SUCCESS, output, null, durationMs, Instant.now(), meta);
    }

    /**
     * Create a failure result.
     */
    public static CommandResult failed(String id, String error, long durationMs, Map<String, Object> meta) {
        return new CommandResult(id, Status.FAILED, null, error, durationMs, Instant.now(), meta);
    }

    /**
     * Create a timeout result.
     */
    public static CommandResult timeout(String id, long durationMs, Map<String, Object> meta) {
        return new CommandResult(id, Status.TIMEOUT, null, "Command execution timed out", durationMs, Instant.now(), meta);
    }

    /**
     * Create a skipped result.
     */
    public static CommandResult skipped(String id, String reason, Map<String, Object> meta) {
        return new CommandResult(id, Status.SKIPPED, null, reason, 0L, Instant.now(), meta);
    }

    /**
     * Check if command succeeded.
     */
    public boolean isSuccess() {
        return status == Status.SUCCESS;
    }

    /**
     * Check if command failed (including timeout).
     */
    public boolean isFailed() {
        return status == Status.FAILED || status == Status.TIMEOUT;
    }
}
