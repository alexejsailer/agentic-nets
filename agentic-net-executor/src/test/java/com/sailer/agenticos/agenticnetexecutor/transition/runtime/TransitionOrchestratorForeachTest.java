package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class TransitionOrchestratorForeachTest {

    @Test
    void foreachSplitsAllSelectedDriverTokensIntoIndependentExecutions() {
        Map<String, Object> one = Map.of("id", "1");
        Map<String, Object> two = Map.of("id", "2");
        Map<String, Object> three = Map.of("id", "3");
        var batches = TransitionOrchestrator.splitForeachBindings(
                true, Map.of("input", List.of(one, two, three)));

        assertThat(batches).hasSize(3);
        assertThat(batches).extracting(batch -> batch.get("input").getFirst())
                .containsExactly(one, two, three);
    }

    @Test
    void singleModeKeepsTheCombinedBinding() {
        Map<String, List<Map<String, Object>>> bindings = Map.of(
                "input", List.of(Map.of("id", "1"), Map.of("id", "2")));
        assertThat(TransitionOrchestrator.splitForeachBindings(false, bindings))
                .containsExactly(bindings);
    }
}
