package com.sailer.agenticos.agenticnetexecutor.transition;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Basic in-memory metrics holder for a transition runtime.
 */
public final class TransitionMetrics {

    private final AtomicLong successfulFires = new AtomicLong();
    private final AtomicLong failedFires = new AtomicLong();
    private final AtomicLong reservedTokens = new AtomicLong();
    private volatile Instant lastStart;
    private volatile Instant lastStop;
    private volatile Instant lastSuccess;
    private volatile Instant lastFailure;

    public void markStart() {
        lastStart = Instant.now();
    }

    public void markStop() {
        lastStop = Instant.now();
    }

    public void markSuccess() {
        successfulFires.incrementAndGet();
        lastSuccess = Instant.now();
    }

    public void markFailure() {
        failedFires.incrementAndGet();
        lastFailure = Instant.now();
    }

    public void addReserved(long count) {
        reservedTokens.addAndGet(count);
    }

    public long successfulFires() {
        return successfulFires.get();
    }

    public long failedFires() {
        return failedFires.get();
    }

    public long reservedTokens() {
        return reservedTokens.get();
    }

    public Instant lastStart() {
        return lastStart;
    }

    public Instant lastStop() {
        return lastStop;
    }

    public Instant lastSuccess() {
        return lastSuccess;
    }

    public Instant lastFailure() {
        return lastFailure;
    }

    public Duration uptime() {
        if (lastStart == null) {
            return Duration.ZERO;
        }
        return Duration.between(lastStart, Instant.now());
    }
}
