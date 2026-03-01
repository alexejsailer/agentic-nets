package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import java.util.Map;

public record TransitionContext(String transitionId,
                                Map<String, Object> attributes) {
    public Object attribute(String key) {
        return attributes != null ? attributes.get(key) : null;
    }
}
