package com.sailer.agenticos.agenticnetexecutor.rest.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Response DTO for event execution operations.
 * Contains execution status, results, and detailed information about the operation.
 */
public record EventExecutionResponse(
    /**
     * Whether the execution was successful overall.
     */
    @JsonProperty("success")
    boolean success,

    /**
     * Model ID that events were executed against.
     */
    @JsonProperty("modelId")
    String modelId,

    /**
     * Total number of events requested.
     */
    @JsonProperty("totalEvents")
    int totalEvents,

    /**
     * Number of events successfully processed.
     */
    @JsonProperty("processedEvents")
    int processedEvents,

    /**
     * Number of events that failed.
     */
    @JsonProperty("failedEvents")
    int failedEvents,

    /**
     * Execution start timestamp.
     */
    @JsonProperty("startTime")
    Instant startTime,

    /**
     * Execution end timestamp.
     */
    @JsonProperty("endTime")
    Instant endTime,

    /**
     * Total execution duration in milliseconds.
     */
    @JsonProperty("durationMs")
    long durationMs,

    /**
     * New model version after execution (if successful).
     */
    @JsonProperty("newModelVersion")
    Long newModelVersion,

    /**
     * Error message if execution failed.
     */
    @JsonProperty("error")
    String error,

    /**
     * Detailed results per event (if verbose mode enabled).
     */
    @JsonProperty("eventResults")
    List<EventExecutionResult> eventResults,

    /**
     * Client-provided transaction ID for tracking.
     */
    @JsonProperty("transactionId")
    String transactionId,

    /**
     * Additional execution metadata.
     */
    @JsonProperty("metadata")
    Map<String, Object> metadata,

    /**
     * List of modified elements with their new versions.
     * Used for optimistic locking on subsequent operations.
     */
    @JsonProperty("modifiedElements")
    List<ModifiedElement> modifiedElements
) {

    /**
     * Get execution duration in milliseconds.
     */
    public long getDurationMs() {
        if (startTime != null && endTime != null) {
            return endTime.toEpochMilli() - startTime.toEpochMilli();
        }
        return durationMs;
    }

    /**
     * Check if execution was partially successful.
     */
    public boolean isPartiallySuccessful() {
        return processedEvents > 0 && failedEvents > 0;
    }

    /**
     * Get success rate as percentage.
     */
    public double getSuccessRate() {
        if (totalEvents == 0) return 0.0;
        return (double) processedEvents / totalEvents * 100.0;
    }

    /**
     * Information about a modified element.
     * Contains element ID and its new version after modification.
     */
    public record ModifiedElement(
        /**
         * ID of the modified element.
         */
        @JsonProperty("id")
        UUID id,

        /**
         * New version of the element after modification.
         */
        @JsonProperty("version")
        long version
    ) {
    }

    /**
     * Result for individual event execution.
     */
    public record EventExecutionResult(
        /**
         * Index of the event in the original request.
         */
        @JsonProperty("index")
        int index,

        /**
         * Event type that was executed.
         */
        @JsonProperty("eventType")
        String eventType,

        /**
         * Element name from the event.
         */
        @JsonProperty("elementName")
        String elementName,

        /**
         * Whether this specific event succeeded.
         */
        @JsonProperty("success")
        boolean success,

        /**
         * Error message if this event failed.
         */
        @JsonProperty("error")
        String error,

        /**
         * Processing time for this event in milliseconds.
         */
        @JsonProperty("processingTimeMs")
        long processingTimeMs,

        /**
         * Result data (e.g., created element ID).
         */
        @JsonProperty("result")
        Map<String, Object> result
    ) {
    }

    /**
     * Builder for creating EventExecutionResponse instances.
     */
    public static class Builder {
        private boolean success;
        private String modelId;
        private int totalEvents;
        private int processedEvents;
        private int failedEvents;
        private Instant startTime;
        private Instant endTime;
        private long durationMs;
        private Long newModelVersion;
        private String error;
        private List<EventExecutionResult> eventResults;
        private String transactionId;
        private Map<String, Object> metadata;
        private List<ModifiedElement> modifiedElements;

        public Builder success(boolean success) {
            this.success = success;
            return this;
        }

        public Builder modelId(String modelId) {
            this.modelId = modelId;
            return this;
        }

        public Builder totalEvents(int totalEvents) {
            this.totalEvents = totalEvents;
            return this;
        }

        public Builder processedEvents(int processedEvents) {
            this.processedEvents = processedEvents;
            return this;
        }

        public Builder failedEvents(int failedEvents) {
            this.failedEvents = failedEvents;
            return this;
        }

        public Builder startTime(Instant startTime) {
            this.startTime = startTime;
            return this;
        }

        public Builder endTime(Instant endTime) {
            this.endTime = endTime;
            return this;
        }

        public Builder durationMs(long durationMs) {
            this.durationMs = durationMs;
            return this;
        }

        public Builder newModelVersion(Long newModelVersion) {
            this.newModelVersion = newModelVersion;
            return this;
        }

        public Builder error(String error) {
            this.error = error;
            return this;
        }

        public Builder eventResults(List<EventExecutionResult> eventResults) {
            this.eventResults = eventResults;
            return this;
        }

        public Builder transactionId(String transactionId) {
            this.transactionId = transactionId;
            return this;
        }

        public Builder metadata(Map<String, Object> metadata) {
            this.metadata = metadata;
            return this;
        }

        public Builder modifiedElements(List<ModifiedElement> modifiedElements) {
            this.modifiedElements = modifiedElements;
            return this;
        }

        public EventExecutionResponse build() {
            return new EventExecutionResponse(
                success, modelId, totalEvents, processedEvents, failedEvents,
                startTime, endTime, durationMs, newModelVersion, error,
                eventResults, transactionId, metadata, modifiedElements
            );
        }
    }

    public static Builder builder() {
        return new Builder();
    }
}
