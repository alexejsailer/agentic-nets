package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Result of executing a transition action.
 *
 * Command-only result payloads for executor transitions.
 */
public record ActionResult(
        boolean success,
        Map<String, List<EmissionPayload>> successPayloads,
        Map<String, List<EmissionPayload>> errorPayloads,
        Map<String, Object> metadata
) {
    public static ActionResult success(Map<String, List<EmissionPayload>> payloads, Map<String, Object> metadata) {
        return new ActionResult(true,
                payloads != null ? payloads : Map.of(),
                Map.of(),
                metadata != null ? metadata : Map.of());
    }

    public static ActionResult failure(Map<String, List<EmissionPayload>> payloads, Map<String, Object> metadata) {
        return new ActionResult(false,
                Map.of(),
                payloads != null ? payloads : Map.of(),
                metadata != null ? metadata : Map.of());
    }

    public List<EmissionPayload> payloadsFor(String postsetId, boolean forSuccess) {
        Map<String, List<EmissionPayload>> source = forSuccess ? successPayloads : errorPayloads;
        return source.getOrDefault(postsetId, Collections.emptyList());
    }
}
