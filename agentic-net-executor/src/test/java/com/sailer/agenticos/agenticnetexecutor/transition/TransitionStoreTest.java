package com.sailer.agenticos.agenticnetexecutor.transition;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link TransitionStore} — the executor's in-memory registry of deployed transitions, keyed by the
 * composite {@code modelId:transitionId} so one executor can serve many models. The keying and lifecycle
 * bookkeeping here decide whether the poll loop finds (and fires) the right transition, so pin: composite-key
 * get/register/remove, the duplicate-registration guard, per-model listing (with the colon preventing
 * {@code m1} from matching {@code m10}), status/error mutation on the stored definition, and snapshot immutability.
 */
class TransitionStoreTest {

    private final ObjectMapper om = new ObjectMapper();
    private TransitionStore store;

    @BeforeEach
    void setUp() {
        store = new TransitionStore();
    }

    private TransitionDefinition def(String modelId, String transitionId) {
        try {
            // The executor only knows the 'command' action subtype (it is the command executor); its
            // CommandAction requires a non-null inputPlace. Presets are omitted (default to empty) — the store
            // only reads the composite key + lifecycle state, never the preset shapes.
            String json = "{\"id\":\"" + transitionId + "\",\"kind\":\"command\","
                    + "\"action\":{\"type\":\"command\",\"inputPlace\":\"input\"}}";
            TransitionInscription insc = om.readValue(json, TransitionInscription.class);
            return TransitionDefinition.builder().modelId(modelId).transitionId(transitionId).inscription(insc).build();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void registerThenGetByCompositeKey() {
        store.register(def("m1", "t1"));
        assertTrue(store.get("m1", "t1").isPresent());
        assertFalse(store.get("m1", "t2").isPresent(), "a different transitionId must miss");
        assertFalse(store.get("m2", "t1").isPresent(), "the same transitionId under a different model must miss");
    }

    @Test
    void registeringADuplicateThrows() {
        store.register(def("m1", "t1"));
        assertThrows(IllegalStateException.class, () -> store.register(def("m1", "t1")));
    }

    @Test
    void replaceOverwritesWithoutError() {
        store.register(def("m1", "t1"));
        TransitionDefinition replacement = def("m1", "t1");
        store.replace(replacement);
        assertEquals(replacement, store.get("m1", "t1").orElseThrow(), "replace must swap the stored definition");
    }

    @Test
    void removeReturnsThenClears() {
        store.register(def("m1", "t1"));
        assertTrue(store.remove("m1", "t1").isPresent());
        assertFalse(store.get("m1", "t1").isPresent());
        assertFalse(store.remove("m1", "t1").isPresent(), "removing a missing transition returns empty");
    }

    @Test
    void listByModelFiltersOnTheColonDelimitedPrefix() {
        store.register(def("m1", "t1"));
        store.register(def("m1", "t2"));
        store.register(def("m10", "t3")); // must NOT be captured by the "m1" query
        assertEquals(2, store.listByModel("m1").size());
        assertEquals(1, store.listByModel("m10").size());
    }

    @Test
    void modelIdsAreDistinct() {
        store.register(def("m1", "t1"));
        store.register(def("m1", "t2"));
        store.register(def("m2", "t3"));
        assertEquals(java.util.Set.of("m1", "m2"), store.modelIds());
    }

    @Test
    void ensureRegisteredThrowsWhenMissing() {
        store.register(def("m1", "t1"));
        store.ensureRegistered("m1", "t1"); // no throw
        assertThrows(IllegalArgumentException.class, () -> store.ensureRegistered("m1", "absent"));
    }

    @Test
    void statusMutationsApplyToTheStoredDefinitionAndNoOpWhenMissing() {
        store.register(def("m1", "t1"));

        store.markStart("m1", "t1");
        assertEquals(TransitionStatus.RUNNING, store.get("m1", "t1").orElseThrow().status());
        store.markStop("m1", "t1");
        assertEquals(TransitionStatus.STOPPED, store.get("m1", "t1").orElseThrow().status());

        // Mutating an unknown transition is a silent no-op, never an exception.
        store.markStart("m1", "ghost");
        store.updateStatus("m1", "ghost", TransitionStatus.ERROR);
    }

    @Test
    void errorIsRecordedThenCleared() {
        store.register(def("m1", "t1"));
        store.recordError("m1", "t1", "boom");
        assertEquals("boom", store.get("m1", "t1").orElseThrow().lastError().orElseThrow());

        store.clearError("m1", "t1");
        assertTrue(store.get("m1", "t1").orElseThrow().lastError().isEmpty());

        store.markFailure("m1", "t1", "fatal");
        assertEquals("fatal", store.get("m1", "t1").orElseThrow().lastError().orElseThrow());
    }

    @Test
    void snapshotIsAnImmutableCopyDecoupledFromLaterWrites() {
        store.register(def("m1", "t1"));
        var snapshot = store.snapshot();
        assertEquals(1, snapshot.size());

        store.register(def("m1", "t2")); // later write must not leak into the taken snapshot
        assertEquals(1, snapshot.size());
        assertThrows(UnsupportedOperationException.class, () -> snapshot.put("x", def("m9", "t9")));
    }

    @Test
    void clearEmptiesTheStore() {
        store.register(def("m1", "t1"));
        store.register(def("m2", "t2"));
        store.clear();
        assertTrue(store.list().isEmpty());
    }
}
