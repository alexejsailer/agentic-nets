package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Result of executing a batch of commands for a specific executor.
 *
 * Example batch result:
 * {
 *   "executor": "fs",
 *   "batchId": "batch-xyz",
 *   "results": [
 *     { "id": "cmd-1", "status": "success", ... },
 *     { "id": "cmd-2", "status": "success", ... }
 *   ],
 *   "totalCount": 2,
 *   "successCount": 2,
 *   "failedCount": 0,
 *   "totalDurationMs": 250,
 *   "completedAt": "2025-01-15T10:30:00Z"
 * }
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record BatchResult(
        String executor,        // Executor type that processed this batch
        String batchId,         // Unique batch identifier
        List<CommandResult> results,  // Individual command results
        int totalCount,         // Total commands in batch
        int successCount,       // Successful commands
        int failedCount,        // Failed commands (including timeouts)
        int skippedCount,       // Skipped commands
        Long totalDurationMs,   // Total batch processing time
        Instant completedAt     // Batch completion timestamp
) {

    @JsonCreator
    public BatchResult(
            @JsonProperty("executor") String executor,
            @JsonProperty("batchId") String batchId,
            @JsonProperty("results") List<CommandResult> results,
            @JsonProperty("totalCount") int totalCount,
            @JsonProperty("successCount") int successCount,
            @JsonProperty("failedCount") int failedCount,
            @JsonProperty("skippedCount") int skippedCount,
            @JsonProperty("totalDurationMs") Long totalDurationMs,
            @JsonProperty("completedAt") Instant completedAt
    ) {
        this.executor = Objects.requireNonNull(executor, "Batch result requires an executor");
        this.batchId = Objects.requireNonNull(batchId, "Batch result requires a batchId");
        this.results = results != null ? List.copyOf(results) : List.of();
        this.totalCount = totalCount;
        this.successCount = successCount;
        this.failedCount = failedCount;
        this.skippedCount = skippedCount;
        this.totalDurationMs = totalDurationMs;
        this.completedAt = completedAt != null ? completedAt : Instant.now();
    }

    /**
     * Create a BatchResult from a list of command results.
     */
    public static BatchResult fromResults(String executor, String batchId, List<CommandResult> results, long durationMs) {
        int success = 0;
        int failed = 0;
        int skipped = 0;

        for (CommandResult result : results) {
            switch (result.status()) {
                case SUCCESS -> success++;
                case FAILED, TIMEOUT -> failed++;
                case SKIPPED -> skipped++;
            }
        }

        return new BatchResult(
                executor,
                batchId,
                results,
                results.size(),
                success,
                failed,
                skipped,
                durationMs,
                Instant.now()
        );
    }

    /**
     * Check if all commands in the batch succeeded.
     */
    public boolean isAllSuccess() {
        return failedCount == 0 && skippedCount == 0;
    }

    /**
     * Check if any command failed.
     */
    public boolean hasFailures() {
        return failedCount > 0;
    }

    /**
     * Get only successful results.
     */
    public List<CommandResult> getSuccessfulResults() {
        return results.stream()
                .filter(CommandResult::isSuccess)
                .collect(Collectors.toList());
    }

    /**
     * Get only failed results.
     */
    public List<CommandResult> getFailedResults() {
        return results.stream()
                .filter(CommandResult::isFailed)
                .collect(Collectors.toList());
    }

    /**
     * Get result by command ID.
     */
    public CommandResult getResultById(String commandId) {
        return results.stream()
                .filter(r -> r.id().equals(commandId))
                .findFirst()
                .orElse(null);
    }

    /**
     * Get a summary map of the batch execution.
     */
    public Map<String, Object> toSummaryMap() {
        return Map.of(
                "executor", executor,
                "batchId", batchId,
                "totalCount", totalCount,
                "successCount", successCount,
                "failedCount", failedCount,
                "skippedCount", skippedCount,
                "totalDurationMs", totalDurationMs != null ? totalDurationMs : 0,
                "allSuccess", isAllSuccess()
        );
    }
}
