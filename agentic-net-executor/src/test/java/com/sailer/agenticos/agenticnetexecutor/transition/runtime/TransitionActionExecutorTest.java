package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.command.CommandActionExecutor;
import com.sailer.agenticos.agenticnetexecutor.transition.command.CommandActionExecutor.CommandActionResult;
import com.sailer.agenticos.agenticnetexecutor.transition.dto.ArcQueryResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Hermetic unit tests for {@link TransitionActionExecutor}.
 *
 * <p>The only collaborator that does real work — {@link CommandActionExecutor} — is mocked so we can
 * assert exactly what this class does on its own: phase-based emit filtering, the {@code from}
 * expression resolver ({@code @result}, {@code @input.data}, {@code @input._meta}, fallbacks),
 * input-token selection by {@code inputPlace}, and credential env-var injection.</p>
 */
class TransitionActionExecutorTest {

    private ObjectMapper objectMapper;
    private CommandActionExecutor commandActionExecutor;
    private TransitionActionExecutor executor;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        commandActionExecutor = mock(CommandActionExecutor.class);
        executor = new TransitionActionExecutor(objectMapper, commandActionExecutor);
    }

    // ---- helpers -----------------------------------------------------------

    private TransitionInscription.Action.CommandAction commandAction(String inputPlace) {
        return new TransitionInscription.Action.CommandAction(inputPlace, null, null, null, null, null);
    }

    private TransitionInscription.Emit emit(String to, String from, String when) {
        return new TransitionInscription.Emit(to, from, null, when, null);
    }

    private TransitionDefinition definition(String inputPlace, List<TransitionInscription.Emit> emits) {
        TransitionInscription inscription = new TransitionInscription(
                "t1", "command",
                null, null,
                commandAction(inputPlace),
                emits,
                null, null, null, null);
        return TransitionDefinition.builder()
                .modelId("m1")
                .transitionId("t1")
                .inscription(inscription)
                .build();
    }

    private ArcQueryResult.TokenBinding binding(String id, String name, String parentId, String type, JsonNode data) {
        return new ArcQueryResult.TokenBinding(id, name, parentId, type, Map.of(), data, null);
    }

    private void stubSuccess() {
        when(commandActionExecutor.execute(any(), anyList(), anyString()))
                .thenReturn(CommandActionResult.empty("t1-1234", List.of()));
    }

    private void stubFailure() {
        when(commandActionExecutor.execute(any(), anyList(), anyString()))
                .thenReturn(CommandActionResult.failed("t1-1234", "boom", 5L));
    }

    @SuppressWarnings("unchecked")
    private List<JsonNode> captureInputTokens() {
        ArgumentCaptor<List<JsonNode>> captor = ArgumentCaptor.forClass(List.class);
        verify(commandActionExecutor).execute(any(), captor.capture(), anyString());
        return captor.getValue();
    }

    // ---- success / error phase routing ------------------------------------

    @Test
    void success_buildsSuccessPayloadFromResult_withCommandResultMetadata() {
        stubSuccess();
        ObjectNode inputData = objectMapper.createObjectNode().put("k", "v");
        TransitionDefinition def = definition("input", List.of(emit("pOut", "@result", "success")));

        ActionResult result = executor.execute(def, Map.of("input", binding("i1", "n", "p", "leaf", inputData)), null);

        assertThat(result.success()).isTrue();
        assertThat(result.errorPayloads()).isEmpty();
        JsonNode resultJson = (JsonNode) result.metadata().get("commandResult");
        assertThat(resultJson).isNotNull();
        assertThat(resultJson.get("success").asBoolean()).isTrue();
        // @result resolves to the very same command-result JSON that went into metadata
        List<EmissionPayload> out = result.successPayloads().get("pOut");
        assertThat(out).hasSize(1);
        assertThat(out.get(0).data()).isSameAs(resultJson);
    }

    @Test
    void success_filtersOutErrorEmits_keepsSuccessAndCatchAll() {
        stubSuccess();
        TransitionDefinition def = definition("input", List.of(
                emit("pOut", "@result", "success"),
                emit("pErr", "@result", "error"),
                emit("pAny", "@result", null)));

        ActionResult result = executor.execute(def,
                Map.of("input", binding("i1", "n", "p", "leaf", objectMapper.createObjectNode())), null);

        assertThat(result.success()).isTrue();
        assertThat(result.successPayloads()).containsKeys("pOut", "pAny");
        assertThat(result.successPayloads()).doesNotContainKey("pErr");
    }

    @Test
    void error_buildsErrorPayloadsOnly_successPayloadsEmpty() {
        stubFailure();
        TransitionDefinition def = definition("input", List.of(
                emit("pOut", "@result", "success"),
                emit("pErr", "@result", "error"),
                emit("pAny", "@result", null)));

        ActionResult result = executor.execute(def,
                Map.of("input", binding("i1", "n", "p", "leaf", objectMapper.createObjectNode())), null);

        assertThat(result.success()).isFalse();
        assertThat(result.successPayloads()).isEmpty();
        assertThat(result.errorPayloads()).containsKeys("pErr", "pAny");
        assertThat(result.errorPayloads()).doesNotContainKey("pOut");
        assertThat(result.metadata()).containsKey("commandResult");
    }

    // ---- from-expression resolution ---------------------------------------

    @Test
    void from_inputData_resolvesToInputBindingData() {
        stubSuccess();
        ObjectNode inputData = objectMapper.createObjectNode().put("foo", "bar");
        TransitionDefinition def = definition("input", List.of(emit("pOut", "@input.data", "success")));

        ActionResult result = executor.execute(def,
                Map.of("input", binding("i1", "n", "p", "leaf", inputData)), null);

        assertThat(result.successPayloads().get("pOut").get(0).data()).isSameAs(inputData);
    }

    @Test
    void from_inputMeta_buildsMetaNodeFromBindingFields() {
        stubSuccess();
        TransitionDefinition def = definition("input", List.of(emit("pOut", "@input._meta", "success")));

        ActionResult result = executor.execute(def,
                Map.of("input", binding("id-42", "the-name", "parent-9", "leaf",
                        objectMapper.createObjectNode())), null);

        JsonNode meta = result.successPayloads().get("pOut").get(0).data();
        assertThat(meta.get("id").asText()).isEqualTo("id-42");
        assertThat(meta.get("name").asText()).isEqualTo("the-name");
        assertThat(meta.get("parentId").asText()).isEqualTo("parent-9");
        assertThat(meta.get("type").asText()).isEqualTo("leaf");
    }

    @Test
    void from_inputData_fallsBackToFirstBinding_whenInputKeyAbsent() {
        stubSuccess();
        ObjectNode data = objectMapper.createObjectNode().put("only", "one");
        // The single binding is NOT keyed "input" — resolver must fall back to it.
        TransitionDefinition def = definition("other", List.of(emit("pOut", "@input.data", "success")));

        ActionResult result = executor.execute(def,
                Map.of("other", binding("i1", "n", "p", "leaf", data)), null);

        assertThat(result.successPayloads().get("pOut").get(0).data()).isSameAs(data);
    }

    @Test
    void from_inputData_fallsBackToResult_whenNoBindings() {
        stubSuccess();
        TransitionDefinition def = definition("ghost", List.of(emit("pOut", "@input.data", "success")));

        ActionResult result = executor.execute(def, Map.of(), null);

        JsonNode resultJson = (JsonNode) result.metadata().get("commandResult");
        assertThat(result.successPayloads().get("pOut").get(0).data()).isSameAs(resultJson);
    }

    @Test
    void from_unknownExpression_fallsBackToResult() {
        stubSuccess();
        TransitionDefinition def = definition("input", List.of(emit("pOut", "totally-unknown", "success")));

        ActionResult result = executor.execute(def,
                Map.of("input", binding("i1", "n", "p", "leaf", objectMapper.createObjectNode())), null);

        JsonNode resultJson = (JsonNode) result.metadata().get("commandResult");
        assertThat(result.successPayloads().get("pOut").get(0).data()).isSameAs(resultJson);
    }

    // ---- input-token selection --------------------------------------------

    @Test
    void inputPlaceSpecified_selectsOnlyThatBindingsData() {
        stubSuccess();
        ObjectNode dIn = objectMapper.createObjectNode().put("pick", "me");
        ObjectNode dOther = objectMapper.createObjectNode().put("skip", "me");
        TransitionDefinition def = definition("input", List.of(emit("pOut", "@result", "success")));

        executor.execute(def, Map.of(
                "input", binding("i1", "n", "p", "leaf", dIn),
                "other", binding("i2", "n", "p", "leaf", dOther)), null);

        List<JsonNode> passed = captureInputTokens();
        assertThat(passed).hasSize(1);
        assertThat(passed.get(0)).isSameAs(dIn);
    }

    @Test
    void inputPlaceMissing_fallsBackToAllBindingsData() {
        stubSuccess();
        ObjectNode da = objectMapper.createObjectNode().put("a", 1);
        ObjectNode db = objectMapper.createObjectNode().put("b", 2);
        TransitionDefinition def = definition("nope", List.of(emit("pOut", "@result", "success")));

        executor.execute(def, Map.of(
                "a", binding("i1", "n", "p", "leaf", da),
                "b", binding("i2", "n", "p", "leaf", db)), null);

        List<JsonNode> passed = captureInputTokens();
        assertThat(passed).hasSize(2).contains(da, db);
    }

    // ---- credential injection ---------------------------------------------

    @Test
    void credentials_injectedAsEnvVars_intoInputTokenArgs_preservingExistingArgs() {
        stubSuccess();
        ObjectNode args = objectMapper.createObjectNode().put("command", "curl $apiKey");
        ObjectNode token = objectMapper.createObjectNode();
        token.put("executor", "bash");
        token.set("args", args);
        TransitionDefinition def = definition("input", List.of(emit("pOut", "@result", "success")));
        TransitionContext ctx = new TransitionContext("t1", Map.of("credentials", Map.of("apiKey", "secret123")));

        executor.execute(def, Map.of("input", binding("i1", "n", "p", "leaf", token)), ctx);

        JsonNode passed = captureInputTokens().get(0);
        assertThat(passed.get("args").get("env").get("apiKey").asText()).isEqualTo("secret123");
        // existing args field must survive the merge
        assertThat(passed.get("args").get("command").asText()).isEqualTo("curl $apiKey");
        // and the original token must not be mutated (deep copy semantics)
        assertThat(token.get("args").has("env")).isFalse();
    }

    @Test
    void noCredentials_leavesInputTokensUntouched() {
        stubSuccess();
        ObjectNode args = objectMapper.createObjectNode().put("command", "echo hi");
        ObjectNode token = objectMapper.createObjectNode();
        token.put("executor", "bash");
        token.set("args", args);
        TransitionDefinition def = definition("input", List.of(emit("pOut", "@result", "success")));

        executor.execute(def, Map.of("input", binding("i1", "n", "p", "leaf", token)), null);

        JsonNode passed = captureInputTokens().get(0);
        assertThat(passed).isSameAs(token);
        assertThat(passed.get("args").has("env")).isFalse();
    }
}
