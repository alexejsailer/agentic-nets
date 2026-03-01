package com.sailer.agenticos.agenticnetexecutor.rest.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * DTO for representing an event request from API clients.
 * This is a simplified representation that will be converted to actual Event objects.
 */
public record EventRequestDto(
    /**
     * Type of event to execute (e.g., "createNode", "createLeaf", "deleteNode", "deleteLeaf").
     */
    @JsonProperty("eventType")
    String eventType,

    /**
     * Parent ID for the operation.
     */
    @JsonProperty("parentId")
    String parentId,

    /**
     * Element ID (optional for create operations - will be auto-generated if null).
     */
    @JsonProperty("id")
    String id,

    /**
     * Element name.
     */
    @JsonProperty("name")
    String name,

    /**
     * Additional properties for the element (optional).
     */
    @JsonProperty("properties")
    Map<String, Object> properties,

    /**
     * Optional event ID for tracking (will be auto-generated if null).
     */
    @JsonProperty("eventId")
    String eventId,

    /**
     * Optional timestamp (will be auto-generated if null).
     */
    @JsonProperty("timestamp")
    Instant timestamp,

    /**
     * Optional expected element ID for consistency checks.
     */
    @JsonProperty("expectedElementId")
    String expectedElementId,

    /**
     * Optional expected version for optimistic locking (per-element version control).
     * When provided, the backend will validate that the element's current version
     * matches this value before applying the update. If versions don't match,
     * the operation fails with HTTP 409 CONFLICT.
     */
    @JsonProperty("expectedVersion")
    Long expectedVersion
) {

    /**
     * Convert parent ID string to UUID, handling "root" special case.
     */
    public UUID getParentIdAsUuid() {
        if (parentId == null || parentId.isBlank() || "root".equalsIgnoreCase(parentId)) {
            return com.sailer.agenticos.agenticnetexecutor.model.util.AgenticOsConstants.ROOT_NODE_UUID;
        }
        return UUID.fromString(parentId);
    }

    /**
     * Convert element ID string to UUID, auto-generating if null.
     */
    public UUID getIdAsUuid() {
        return (id == null || id.isBlank() || "auto".equalsIgnoreCase(id))
            ? UUID.randomUUID()
            : UUID.fromString(id);
    }

    /**
     * Convert event ID string to UUID, auto-generating if null.
     */
    public UUID getEventIdAsUuid() {
        return (eventId == null || eventId.isBlank())
            ? UUID.randomUUID()
            : UUID.fromString(eventId);
    }

    /**
     * Get timestamp, defaulting to now if null.
     */
    public Instant getTimestampOrNow() {
        return timestamp != null ? timestamp : Instant.now();
    }

    /**
     * Convert expected element ID string to UUID.
     */
    public UUID getExpectedElementIdAsUuid() {
        return (expectedElementId == null || expectedElementId.isBlank())
            ? null
            : UUID.fromString(expectedElementId);
    }

    /**
     * Validate that the event type is supported.
     */
    public boolean isValidEventType() {
        return eventType != null && switch (eventType.toLowerCase()) {
            case "createnode", "createleaf", "deletenode", "deleteleaf",
                 "updateproperty", "deleteproperty" -> true;
            default -> false;
        };
    }

    /**
     * Normalize event type to match Event class names.
     */
    public String getNormalizedEventType() {
        if (eventType == null) return null;

        return switch (eventType.toLowerCase()) {
            case "createnode" -> "createNode";
            case "createleaf" -> "createLeaf";
            case "deletenode" -> "deleteNode";
            case "deleteleaf" -> "deleteLeaf";
            case "updateproperty" -> "updateProperty";
            case "deleteproperty" -> "deleteProperty";
            default -> eventType;
        };
    }
}
