package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link BatchResult} — the per-executor batch summary the executor reports back to master. Its
 * aggregation (how many succeeded / failed / were skipped, and whether the whole batch is clean) drives how
 * master routes emissions and consumes tokens, so a miscount would misreport execution outcomes. Pins the
 * {@code fromResults} tallies (TIMEOUT counts as failed), the all-success / has-failures predicates, the
 * per-id lookup, and the summary map. Pure value object.
 */
class BatchResultTest {

    private final ObjectMapper om = new ObjectMapper();

    private CommandResult result(String id, CommandResult.Status status) {
        return new CommandResult(id, status, om.createObjectNode(), null, 1L, null, Map.of());
    }

    @Test
    void fromResultsTalliesEachStatusAndTimeoutCountsAsFailed() {
        BatchResult batch = BatchResult.fromResults("bash", "batch-1", List.of(
                result("a", CommandResult.Status.SUCCESS),
                result("b", CommandResult.Status.SUCCESS),
                result("c", CommandResult.Status.FAILED),
                result("d", CommandResult.Status.TIMEOUT),
                result("e", CommandResult.Status.SKIPPED)), 42L);

        assertEquals(5, batch.totalCount());
        assertEquals(2, batch.successCount());
        assertEquals(2, batch.failedCount(), "TIMEOUT must be tallied with FAILED");
        assertEquals(1, batch.skippedCount());
        assertEquals("bash", batch.executor());
        assertEquals("batch-1", batch.batchId());
    }

    @Test
    void isAllSuccessOnlyWhenNoFailuresOrSkips() {
        BatchResult clean = BatchResult.fromResults("bash", "b", List.of(
                result("a", CommandResult.Status.SUCCESS),
                result("b", CommandResult.Status.SUCCESS)), 0L);
        assertTrue(clean.isAllSuccess());
        assertFalse(clean.hasFailures());

        BatchResult withSkip = BatchResult.fromResults("bash", "b", List.of(
                result("a", CommandResult.Status.SUCCESS),
                result("b", CommandResult.Status.SKIPPED)), 0L);
        assertFalse(withSkip.isAllSuccess(), "a skipped command means the batch is not all-success");
        assertFalse(withSkip.hasFailures(), "...but a skip is not a failure");
    }

    @Test
    void hasFailuresReflectsFailedOrTimeoutResults() {
        BatchResult batch = BatchResult.fromResults("bash", "b", List.of(
                result("a", CommandResult.Status.SUCCESS),
                result("b", CommandResult.Status.FAILED)), 0L);
        assertTrue(batch.hasFailures());
        assertFalse(batch.isAllSuccess());
    }

    @Test
    void getSuccessfulAndFailedResultsPartitionTheBatch() {
        BatchResult batch = BatchResult.fromResults("bash", "b", List.of(
                result("ok", CommandResult.Status.SUCCESS),
                result("bad", CommandResult.Status.FAILED),
                result("slow", CommandResult.Status.TIMEOUT)), 0L);

        assertEquals(List.of("ok"), batch.getSuccessfulResults().stream().map(CommandResult::id).toList());
        // isFailed() includes TIMEOUT.
        assertEquals(List.of("bad", "slow"), batch.getFailedResults().stream().map(CommandResult::id).toList());
    }

    @Test
    void getResultByIdFindsOrReturnsNull() {
        BatchResult batch = BatchResult.fromResults("bash", "b", List.of(
                result("cmd-1", CommandResult.Status.SUCCESS)), 0L);
        assertEquals("cmd-1", batch.getResultById("cmd-1").id());
        assertNull(batch.getResultById("missing"));
    }

    @Test
    void toSummaryMapReportsCountsAndAllSuccessFlag() {
        BatchResult batch = BatchResult.fromResults("bash", "batch-9", List.of(
                result("a", CommandResult.Status.SUCCESS),
                result("b", CommandResult.Status.FAILED)), 7L);
        Map<String, Object> summary = batch.toSummaryMap();

        assertEquals("bash", summary.get("executor"));
        assertEquals("batch-9", summary.get("batchId"));
        assertEquals(2, summary.get("totalCount"));
        assertEquals(1, summary.get("successCount"));
        assertEquals(1, summary.get("failedCount"));
        assertEquals(7L, summary.get("totalDurationMs"));
        assertEquals(false, summary.get("allSuccess"));
    }

    @Test
    void emptyBatchIsVacuouslyAllSuccess() {
        BatchResult batch = BatchResult.fromResults("bash", "b", List.of(), 0L);
        assertEquals(0, batch.totalCount());
        assertTrue(batch.isAllSuccess());
        assertFalse(batch.hasFailures());
    }
}
