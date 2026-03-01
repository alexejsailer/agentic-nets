package com.sailer.agenticos.agenticnetexecutor.transition;

/**
 * Lifecycle status for a registered transition runtime.
 */
public enum TransitionStatus {
    REGISTERED,
    STARTING,
    RUNNING,
    PAUSED,
    STOPPED,
    ERROR;

    public boolean isRunning() {
        return this == RUNNING;
    }
}
