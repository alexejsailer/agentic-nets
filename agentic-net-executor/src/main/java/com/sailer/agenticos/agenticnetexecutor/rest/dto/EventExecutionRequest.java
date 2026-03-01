package com.sailer.agenticos.agenticnetexecutor.rest.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

/**
 * Request DTO for executing a list of events against a model.
 * Contains the model identifier and ordered list of events to execute.
 */
public record EventExecutionRequest(
    /**
     * ID of the model to execute events against.
     * Optional if provided via path parameter.
     */
    @JsonProperty("modelId")
    String modelId,

    /**
     * Ordered list of events to execute.
     * Events will be processed in the exact order provided.
     */
    @JsonProperty("events")
    List<EventRequestDto> events,

    /**
     * Optional execution options and metadata.
     */
    @JsonProperty("options")
    Map<String, Object> options,

    /**
     * Optional client-provided transaction ID for tracking.
     */
    @JsonProperty("transactionId")
    String transactionId,

    /**
     * Whether to stop execution on first error (default: true).
     */
    @JsonProperty("stopOnError")
    Boolean stopOnError,

    /**
     * Whether to return detailed execution results (default: false).
     */
    @JsonProperty("verbose")
    Boolean verbose
) {

    /**
     * Get stop-on-error flag with default.
     */
    public boolean shouldStopOnError() {
        return stopOnError != null ? stopOnError : true;
    }

    /**
     * Get verbose flag with default.
     */
    public boolean isVerbose() {
        return verbose != null ? verbose : false;
    }

    /**
     * Validate the request.
     */
    public boolean isValid() {
        // Must have events
        if (events == null || events.isEmpty()) {
            return false;
        }

        // All events must be valid
        for (EventRequestDto event : events) {
            if (!event.isValidEventType() || event.name() == null || event.name().isBlank()) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get validation error message if invalid.
     */
    public String getValidationError() {
        if (events == null || events.isEmpty()) {
            return "Events list cannot be empty";
        }

        for (int i = 0; i < events.size(); i++) {
            EventRequestDto event = events.get(i);
            if (!event.isValidEventType()) {
                return "Invalid event type at index " + i + ": " + event.eventType();
            }
            if (event.name() == null || event.name().isBlank()) {
                return "Event name cannot be empty at index " + i;
            }
        }

        return null;
    }

    /**
     * Get the effective model ID (from field or parameter).
     */
    public String getEffectiveModelId(String pathModelId) {
        // Path parameter takes precedence
        if (pathModelId != null && !pathModelId.isBlank()) {
            return pathModelId;
        }
        return modelId;
    }

    /**
     * Get event count.
     */
    public int getEventCount() {
        return events != null ? events.size() : 0;
    }
}
