package com.sailer.agenticos.agenticnetexecutor.transition.service;

import com.sailer.agenticos.agenticnetexecutor.service.MasterPollingService;
import com.sailer.agenticos.agenticnetexecutor.transition.dto.ArcQueryResult;
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
 * Hermetic unit tests for {@link ConsumptionService}.
 *
 * <p>{@link MasterPollingService} is mocked so we can assert the pure decision seam this class owns:
 * the {@code effectiveParentId} resolution in {@code toTokenReferences} ({@code _parentPlace}
 * property overrides {@code parentId}, blank falls back), the empty-token short-circuit, the
 * consume-vs-release routing to the correct master call, and the error-wrapping contract.</p>
 */
class ConsumptionServiceTest {

    private static final String MODEL_ID = "modelX";
    private static final String HOST = "modelX@localhost:8080";

    private MasterPollingService masterPollingService;
    private ConsumptionService service;

    @BeforeEach
    void setUp() {
        masterPollingService = mock(MasterPollingService.class);
        when(masterPollingService.consumeTokens(anyString(), anyList())).thenReturn(Mono.empty());
        when(masterPollingService.releaseTokens(anyString(), anyList())).thenReturn(Mono.empty());
        service = new ConsumptionService(masterPollingService);
    }

    // ---- helpers -----------------------------------------------------------

    private ArcQueryResult.TokenBinding token(String id, String parentId,
                                              String type, Map<String, String> properties) {
        return new ArcQueryResult.TokenBinding(id, "tok-" + id, parentId, type, properties, null, null);
    }

    @SuppressWarnings("unchecked")
    private ArgumentCaptor<List<MasterPollingService.TokenReference>> refCaptor() {
        return ArgumentCaptor.forClass(List.class);
    }

    // ---- empty / null short-circuit ---------------------------------------

    @Test
    void consume_withEmptyList_doesNotCallMaster() {
        service.consume(HOST, MODEL_ID, List.of());
        verifyNoInteractions(masterPollingService);
    }

    @Test
    void consume_withNullList_doesNotCallMaster() {
        service.consume(HOST, MODEL_ID, null);
        verifyNoInteractions(masterPollingService);
    }

    @Test
    void release_withEmptyList_doesNotCallMaster() {
        service.release(HOST, MODEL_ID, List.of());
        verifyNoInteractions(masterPollingService);
    }

    // ---- effectiveParentId resolution seam --------------------------------

    @Test
    void consume_parentPlaceProperty_overridesParentId() {
        var tok = token("id-1", "place-from-parentId", "Leaf",
                Map.of("_parentPlace", "place-from-property"));

        service.consume(HOST, MODEL_ID, List.of(tok));

        var captor = refCaptor();
        verify(masterPollingService).consumeTokens(eq(MODEL_ID), captor.capture());
        List<MasterPollingService.TokenReference> refs = captor.getValue();
        assertThat(refs).hasSize(1);
        assertThat(refs.get(0).id()).isEqualTo("id-1");
        assertThat(refs.get(0).parentId()).isEqualTo("place-from-property");
        assertThat(refs.get(0).name()).isEqualTo("tok-id-1");
    }

    @Test
    void consume_noParentPlaceProperty_fallsBackToParentId() {
        var tok = token("id-2", "place-from-parentId", "Leaf", Map.of());

        service.consume(HOST, MODEL_ID, List.of(tok));

        var captor = refCaptor();
        verify(masterPollingService).consumeTokens(eq(MODEL_ID), captor.capture());
        assertThat(captor.getValue().get(0).parentId()).isEqualTo("place-from-parentId");
    }

    @Test
    void consume_blankParentPlaceProperty_fallsBackToParentId() {
        var tok = token("id-3", "place-from-parentId", "Leaf",
                Map.of("_parentPlace", "   "));

        service.consume(HOST, MODEL_ID, List.of(tok));

        var captor = refCaptor();
        verify(masterPollingService).consumeTokens(eq(MODEL_ID), captor.capture());
        assertThat(captor.getValue().get(0).parentId()).isEqualTo("place-from-parentId");
    }

    @Test
    void consume_nullProperties_usesParentId() {
        var tok = token("id-4", "place-from-parentId", "Node", null);

        service.consume(HOST, MODEL_ID, List.of(tok));

        var captor = refCaptor();
        verify(masterPollingService).consumeTokens(eq(MODEL_ID), captor.capture());
        assertThat(captor.getValue().get(0).parentId()).isEqualTo("place-from-parentId");
    }

    // ---- release routes to releaseTokens, same resolution ------------------

    @Test
    void release_routesToReleaseTokens_withResolvedParent() {
        var tok = token("id-5", "ignored", "Leaf",
                Map.of("_parentPlace", "place-release"));

        service.release(HOST, MODEL_ID, List.of(tok));

        var captor = refCaptor();
        verify(masterPollingService).releaseTokens(eq(MODEL_ID), captor.capture());
        verify(masterPollingService, never()).consumeTokens(anyString(), anyList());
        assertThat(captor.getValue().get(0).parentId()).isEqualTo("place-release");
    }

    // ---- error wrapping contract ------------------------------------------

    @Test
    void consume_masterFailure_isWrappedInIllegalState() {
        when(masterPollingService.consumeTokens(anyString(), anyList()))
                .thenReturn(Mono.error(new RuntimeException("node down")));
        var tok = token("id-6", "p", "Leaf", Map.of());

        assertThatThrownBy(() -> service.consume(HOST, MODEL_ID, List.of(tok)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Token consumption via master failed");
    }

    @Test
    void release_masterFailure_isWrappedInIllegalState() {
        when(masterPollingService.releaseTokens(anyString(), anyList()))
                .thenReturn(Mono.error(new RuntimeException("node down")));
        var tok = token("id-7", "p", "Leaf", Map.of());

        assertThatThrownBy(() -> service.release(HOST, MODEL_ID, List.of(tok)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Token lock release via master failed");
    }
}
