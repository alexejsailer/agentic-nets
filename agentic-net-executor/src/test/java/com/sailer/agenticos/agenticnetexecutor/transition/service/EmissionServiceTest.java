package com.sailer.agenticos.agenticnetexecutor.transition.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetexecutor.service.MasterPollingService;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.runtime.ActionResult;
import com.sailer.agenticos.agenticnetexecutor.transition.runtime.EmissionPayload;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import reactor.core.publisher.Mono;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Hermetic unit tests for {@link EmissionService}.
 *
 * <p>{@link MasterPollingService} is mocked so we can assert the pure routing/enrichment seam:
 * success uses {@code successPayloads} / failure merges {@code errorPayloads}; postset lookup routes
 * to the correct place id and extracts the target model id from the {@code model@host:port} form;
 * null/missing payload data and unknown postsets are skipped; enrichment adds status + strips
 * {@code _lock}; and the "no target model" / master-error contracts hold.</p>
 */
class EmissionServiceTest {

    private ObjectMapper objectMapper;
    private MasterPollingService masterPollingService;
    private EmissionService service;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        masterPollingService = mock(MasterPollingService.class);
        when(masterPollingService.emitTokens(anyString(), anyList())).thenReturn(Mono.empty());
        service = new EmissionService(objectMapper, masterPollingService);
    }

    // ---- helpers -----------------------------------------------------------

    private TransitionDefinition definitionWithPostset(String postsetKey, String placeId, String host) {
        var postset = new TransitionInscription.Postset(placeId, host, "desc", null, null);
        var action = new TransitionInscription.Action.CommandAction("p-in", null, null, null, null, null);
        var inscription = new TransitionInscription(
                "t1", "command", null, Map.of(postsetKey, postset),
                action, null, null, null, null, null);
        return TransitionDefinition.builder()
                .modelId("modelX").transitionId("t1").inscription(inscription).build();
    }

    private EmissionPayload objectPayload(String name, Map<String, Object> data) {
        return new EmissionPayload(name, objectMapper.valueToTree(data));
    }

    @SuppressWarnings("unchecked")
    private ArgumentCaptor<List<MasterPollingService.TokenEmission>> emissionCaptor() {
        return ArgumentCaptor.forClass(List.class);
    }

    // ---- success path: routing + enrichment --------------------------------

    @Test
    void emit_success_routesToPostsetPlace_extractsModelId_enrichesStatus() {
        var def = definitionWithPostset("out", "P_out", "targetModel@localhost:8080");
        var result = ActionResult.success(
                Map.of("out", List.of(objectPayload("tok-a", Map.of("k", "v")))),
                Map.of());

        service.emit(def, result);

        var captor = emissionCaptor();
        verify(masterPollingService).emitTokens(eq("targetModel"), captor.capture());
        List<MasterPollingService.TokenEmission> emissions = captor.getValue();
        assertThat(emissions).hasSize(1);
        MasterPollingService.TokenEmission e = emissions.get(0);
        assertThat(e.placeId()).isEqualTo("P_out");
        assertThat(e.tokenName()).isEqualTo("tok-a");
        assertThat(e.tokenData())
                .containsEntry("k", "v")
                .containsEntry("status", "success")
                .containsEntry("transitionId", "t1")
                .containsKey("emittedAt");
    }

    @Test
    void emit_success_stripsLockProperties() {
        var def = definitionWithPostset("out", "P_out", "targetModel@localhost:8080");
        var result = ActionResult.success(
                Map.of("out", List.of(objectPayload("tok-a",
                        Map.of("k", "v", "_lock", "owner-1", "_lockExpires", "999")))),
                Map.of());

        service.emit(def, result);

        var captor = emissionCaptor();
        verify(masterPollingService).emitTokens(eq("targetModel"), captor.capture());
        assertThat(captor.getValue().get(0).tokenData())
                .doesNotContainKey("_lock")
                .doesNotContainKey("_lockExpires")
                .containsEntry("k", "v");
    }

    // ---- failure path: errorPayloads used, status=error --------------------

    @Test
    void emit_failure_usesErrorPayloads_statusError() {
        var def = definitionWithPostset("err", "P_err", "targetModel@localhost:8080");
        var result = ActionResult.failure(
                Map.of("err", List.of(objectPayload("tok-e", Map.of("reason", "boom")))),
                Map.of());

        service.emit(def, result);

        var captor = emissionCaptor();
        verify(masterPollingService).emitTokens(eq("targetModel"), captor.capture());
        MasterPollingService.TokenEmission e = captor.getValue().get(0);
        assertThat(e.placeId()).isEqualTo("P_err");
        assertThat(e.tokenData())
                .containsEntry("reason", "boom")
                .containsEntry("status", "error");
    }

    // ---- non-object payload wrapping --------------------------------------

    @Test
    void emit_nonObjectPayload_isWrappedInValue() {
        var def = definitionWithPostset("out", "P_out", "targetModel@localhost:8080");
        EmissionPayload textPayload = new EmissionPayload("tok-t", objectMapper.getNodeFactory().textNode("hello"));
        var result = ActionResult.success(Map.of("out", List.of(textPayload)), Map.of());

        service.emit(def, result);

        var captor = emissionCaptor();
        verify(masterPollingService).emitTokens(eq("targetModel"), captor.capture());
        assertThat(captor.getValue().get(0).tokenData())
                .containsEntry("value", "hello")
                .containsEntry("status", "success");
    }

    // ---- skip / no-op branches --------------------------------------------

    @Test
    void emit_emptyPayloads_doesNotCallMaster() {
        var def = definitionWithPostset("out", "P_out", "targetModel@localhost:8080");
        service.emit(def, ActionResult.success(Map.of(), Map.of()));
        verifyNoInteractions(masterPollingService);
    }

    @Test
    void emit_unknownPostset_isSkipped_noMasterCall() {
        var def = definitionWithPostset("out", "P_out", "targetModel@localhost:8080");
        var result = ActionResult.success(
                Map.of("NOT_A_POSTSET", List.of(objectPayload("x", Map.of("k", "v")))),
                Map.of());

        service.emit(def, result);

        verify(masterPollingService, never()).emitTokens(anyString(), anyList());
    }

    @Test
    void emit_nullDataPayload_isSkipped_noMasterCall() {
        var def = definitionWithPostset("out", "P_out", "targetModel@localhost:8080");
        var nullDataPayload = new EmissionPayload("tok-null", objectMapper.nullNode());
        var result = ActionResult.success(Map.of("out", List.of(nullDataPayload)), Map.of());

        service.emit(def, result);

        verify(masterPollingService, never()).emitTokens(anyString(), anyList());
    }

    @Test
    void emit_hostWithoutModelPrefix_doesNotEmit() {
        // host has no "@" so no target model id can be extracted -> no emission
        var def = definitionWithPostset("out", "P_out", "localhost:8080");
        var result = ActionResult.success(
                Map.of("out", List.of(objectPayload("tok-a", Map.of("k", "v")))),
                Map.of());

        service.emit(def, result);

        verify(masterPollingService, never()).emitTokens(anyString(), anyList());
    }

    // ---- error wrapping contract ------------------------------------------

    @Test
    void emit_masterFailure_isWrappedInIllegalState() {
        when(masterPollingService.emitTokens(anyString(), anyList()))
                .thenReturn(Mono.error(new RuntimeException("node down")));
        var def = definitionWithPostset("out", "P_out", "targetModel@localhost:8080");
        var result = ActionResult.success(
                Map.of("out", List.of(objectPayload("tok-a", Map.of("k", "v")))),
                Map.of());

        assertThatThrownBy(() -> service.emit(def, result))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Token emission via master failed");
    }
}
