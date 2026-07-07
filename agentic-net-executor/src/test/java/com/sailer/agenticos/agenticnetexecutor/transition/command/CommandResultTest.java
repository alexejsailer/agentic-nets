package com.sailer.agenticos.agenticnetexecutor.transition.command;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Regression tests for the null-tolerant meta copy.
 *
 * <p>Production incident (staging, 2026-07-07): a command token whose meta carried a
 * template-resolved null ({@code {"_correlationId": null}}) made {@code Map.copyOf} throw a
 * bare NPE in the constructor — on the success path AND again inside
 * {@code CommandResult.failed(...)} — so the orchestrator never produced a result, the token
 * was never consumed, and the transition retried every ~2s indefinitely.
 */
class CommandResultTest {

    @Test
    void metaWithNullValueDoesNotThrowAndDropsTheEntry() {
        Map<String, Object> meta = new HashMap<>();
        meta.put("_correlationId", null); // the exact poison from the incident
        meta.put("kept", "value");

        CommandResult result = CommandResult.success("cmd-1", null, 5L, meta);

        assertThat(result.meta()).containsExactlyEntriesOf(Map.of("kept", "value"));
        assertThat(result.status()).isEqualTo(CommandResult.Status.SUCCESS);
    }

    @Test
    void failedWithNullErrorAndNullValuedMetaDoesNotThrow() {
        Map<String, Object> meta = new HashMap<>();
        meta.put("_correlationId", null);

        // e.getMessage() can be null (e.g. a bare NPE) — the failure wrapper must survive it.
        CommandResult result = CommandResult.failed("cmd-2", null, 7L, meta);

        assertThat(result.status()).isEqualTo(CommandResult.Status.FAILED);
        assertThat(result.error()).isNull();
        assertThat(result.meta()).isEmpty();
    }

    @Test
    void nullMetaMapStillYieldsEmptyMap() {
        CommandResult result = CommandResult.failed("cmd-3", "boom", 1L, null);
        assertThat(result.meta()).isEmpty();
    }

    @Test
    void nullKeyIsDroppedToo() {
        Map<String, Object> meta = new HashMap<>();
        meta.put(null, "orphan");
        meta.put("ok", 1);

        CommandResult result = CommandResult.success("cmd-4", null, 2L, meta);

        assertThat(result.meta()).containsExactlyEntriesOf(Map.of("ok", 1));
    }

    @Test
    void idIsStillRequired() {
        assertThatThrownBy(() -> CommandResult.success(null, null, 1L, Map.of()))
                .isInstanceOf(NullPointerException.class)
                .hasMessageContaining("requires an id");
    }
}
