package com.sailer.agenticos.agenticnetexecutor.transition;

/**
 * Execution mode for a transition binding evaluation.
 */
public enum TransitionMode {
    /**
     * Single binding evaluation – transition fires once per activation.
     */
    SINGLE,
    /**
     * Foreach binding evaluation – transition fires once per bound token.
     */
    FOREACH;

    public static TransitionMode fromString(String value) {
        if (value == null || value.isBlank()) {
            return SINGLE;
        }
        return switch (value.toLowerCase()) {
            case "foreach", "for_each", "for-each" -> FOREACH;
            default -> SINGLE;
        };
    }
}
