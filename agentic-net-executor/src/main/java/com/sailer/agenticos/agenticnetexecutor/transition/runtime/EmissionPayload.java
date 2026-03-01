package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import com.fasterxml.jackson.databind.JsonNode;

public record EmissionPayload(String name, JsonNode data) {
    public String effectiveName(String fallback) {
        if (name != null && !name.isBlank()) {
            return name;
        }
        return fallback;
    }
}
