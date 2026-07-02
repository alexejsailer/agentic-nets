package com.sailer.agenticos.agenticnetexecutor.transition;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link TransitionMetrics} — the per-transition counters the executor reports back to master
 * (successful vs failed fires, reserved tokens, lifecycle timestamps). A mix-up (success bumping the failure
 * counter, or the two counters not being independent) would corrupt every fire-rate/health signal downstream,
 * so pin the independence and accumulation of the counters plus the start/uptime bookkeeping.
 */
class TransitionMetricsTest {

    @Test
    void freshMetricsAreAllZeroAndUnset() {
        TransitionMetrics m = new TransitionMetrics();
        assertEquals(0, m.successfulFires());
        assertEquals(0, m.failedFires());
        assertEquals(0, m.reservedTokens());
        assertNull(m.lastStart());
        assertNull(m.lastSuccess());
        assertNull(m.lastFailure());
        assertEquals(Duration.ZERO, m.uptime(), "uptime is ZERO until the transition has started");
    }

    @Test
    void successAndFailureCountersAreIndependent() {
        TransitionMetrics m = new TransitionMetrics();
        m.markSuccess();
        m.markSuccess();
        m.markFailure();

        assertEquals(2, m.successfulFires(), "two successes must not leak into the failure counter");
        assertEquals(1, m.failedFires());
        assertNotNull(m.lastSuccess());
        assertNotNull(m.lastFailure());
    }

    @Test
    void reservedTokensAccumulate() {
        TransitionMetrics m = new TransitionMetrics();
        m.addReserved(3);
        m.addReserved(4);
        assertEquals(7, m.reservedTokens());
    }

    @Test
    void markStartSetsTimestampAndUptimeBecomesPositive() throws InterruptedException {
        TransitionMetrics m = new TransitionMetrics();
        m.markStart();
        Thread.sleep(2); // let a measurable amount of time pass since start
        assertNotNull(m.lastStart());
        assertTrue(m.uptime().toNanos() > 0, "uptime is measured from lastStart once started");
        assertTrue(!m.uptime().isNegative());
    }

    @Test
    void markStopRecordsAStopTimestamp() {
        TransitionMetrics m = new TransitionMetrics();
        assertNull(m.lastStop());
        m.markStop();
        assertNotNull(m.lastStop());
    }
}
