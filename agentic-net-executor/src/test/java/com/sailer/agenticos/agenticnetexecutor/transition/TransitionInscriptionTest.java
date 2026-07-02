package com.sailer.agenticos.agenticnetexecutor.transition;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertIterableEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link TransitionInscription} — the immutable JSON-loaded transition definition. The canonical
 * (@JsonCreator) constructor is where every runtime default is decided, so this pins the null-coalescing
 * behaviour that the rest of the executor relies on: {@code kind} → {@code "task"}, {@code presets}/{@code postsets}
 * → empty (via the key-validating {@code copyLinkedMap}), {@code emit} → empty list, {@code idempotency} → the
 * shared disabled default, {@code mode} → {@link TransitionMode#SINGLE}, {@code metadata} → empty map. It also
 * pins the two hard requireNonNull contracts (id, action), the {@code copyLinkedMap} null/blank-key rejection,
 * the defensive-copy immutability of the collection fields, {@link TransitionInscription#isForeach()}, and the
 * nested value records (Preset/Postset/Emit/Idempotency/CommandAction and their own defaults + helpers).
 *
 * <p>The executor's {@code Action} is a sealed interface permitting only {@code CommandAction} (type "command",
 * non-null inputPlace), so a command action is used everywhere a non-null action is required.</p>
 */
class TransitionInscriptionTest {

    private final ObjectMapper om = new ObjectMapper();

    private static TransitionInscription.Action cmdAction() {
        return new TransitionInscription.Action.CommandAction("input", null, null, null, null, null);
    }

    private static TransitionInscription.Preset preset(String placeId) {
        return new TransitionInscription.Preset(placeId, "local", "FROM $ WHERE $.x==1",
                null, null, null, null, null, null, null);
    }

    // ======== canonical constructor defaults ========

    @Test
    void nullOptionalsGetTheirDefaults() {
        TransitionInscription insc = new TransitionInscription(
                "t1", null, null, null, cmdAction(), null, null, null, null, null);

        assertEquals("t1", insc.id());
        assertEquals("task", insc.kind(), "kind must default to 'task'");
        assertTrue(insc.presets().isEmpty(), "null presets -> empty map");
        assertTrue(insc.postsets().isEmpty(), "null postsets -> empty map");
        assertTrue(insc.emit().isEmpty(), "null emit -> empty list");
        assertEquals(TransitionMode.SINGLE, insc.mode(), "null mode -> SINGLE");
        assertTrue(insc.metadata().isEmpty(), "null metadata -> empty map");
        assertNull(insc.concurrency(), "concurrency is passed through untouched (nullable)");
        assertNotNull(insc.idempotency(), "null idempotency -> shared default instance");
        assertFalse(insc.idempotency().enabled(), "the default idempotency is disabled (no key)");
    }

    @Test
    void explicitValuesArePreserved() {
        TransitionInscription insc = new TransitionInscription(
                "t2", "command",
                Map.of("in", preset("p-in")),
                Map.of("out", new TransitionInscription.Postset("p-out", "local", null, null, null)),
                cmdAction(),
                List.of(new TransitionInscription.Emit("p-out", null, null, null, null)),
                new TransitionInscription.Idempotency("k", "H", 5L),
                TransitionMode.FOREACH,
                7,
                Map.of("owner", "qa"));

        assertEquals("command", insc.kind());
        assertEquals(1, insc.presets().size());
        assertEquals(1, insc.postsets().size());
        assertEquals(1, insc.emit().size());
        assertEquals(7, insc.concurrency());
        assertEquals("qa", insc.metadata().get("owner"));
        assertTrue(insc.idempotency().enabled());
    }

    // ======== hard requireNonNull contracts ========

    @Test
    void nullIdIsRejected() {
        NullPointerException ex = assertThrows(NullPointerException.class, () -> new TransitionInscription(
                null, "task", null, null, cmdAction(), null, null, null, null, null));
        assertTrue(ex.getMessage().contains("transition id"), "message should name the id field");
    }

    @Test
    void nullActionIsRejected() {
        NullPointerException ex = assertThrows(NullPointerException.class, () -> new TransitionInscription(
                "t1", "task", null, null, null, null, null, null, null, null));
        assertTrue(ex.getMessage().contains("action"), "message should name the action field");
    }

    // ======== copyLinkedMap key validation (presets + postsets share it) ========

    @Test
    void presetsWithNullKeyRejected() {
        Map<String, TransitionInscription.Preset> bad = new HashMap<>();
        bad.put(null, preset("p"));
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () -> new TransitionInscription(
                "t1", "task", bad, null, cmdAction(), null, null, null, null, null));
        assertTrue(ex.getMessage().contains("null or blank"));
    }

    @Test
    void presetsWithBlankKeyRejected() {
        Map<String, TransitionInscription.Preset> bad = new LinkedHashMap<>();
        bad.put("   ", preset("p"));
        assertThrows(IllegalArgumentException.class, () -> new TransitionInscription(
                "t1", "task", bad, null, cmdAction(), null, null, null, null, null));
    }

    @Test
    void postsetsWithBlankKeyRejected() {
        Map<String, TransitionInscription.Postset> bad = new LinkedHashMap<>();
        bad.put("", new TransitionInscription.Postset("p-out", "local", null, null, null));
        assertThrows(IllegalArgumentException.class, () -> new TransitionInscription(
                "t1", "task", null, bad, cmdAction(), null, null, null, null, null));
    }

    @Test
    void copyLinkedMapPreservesInsertionOrder() {
        Map<String, TransitionInscription.Preset> src = new LinkedHashMap<>();
        src.put("b", preset("pb"));
        src.put("a", preset("pa"));
        src.put("c", preset("pc"));
        TransitionInscription insc = new TransitionInscription(
                "t1", "task", src, null, cmdAction(), null, null, null, null, null);
        assertIterableEquals(List.of("b", "a", "c"), insc.presets().keySet(),
                "copyLinkedMap must preserve source insertion order");
    }

    // ======== defensive-copy immutability ========

    @Test
    void collectionFieldsAreUnmodifiable() {
        TransitionInscription insc = new TransitionInscription(
                "t1", "task",
                Map.of("in", preset("p-in")),
                Map.of("out", new TransitionInscription.Postset("p-out", "local", null, null, null)),
                cmdAction(),
                List.of(new TransitionInscription.Emit("p-out", null, null, null, null)),
                null, null, null, Map.of("k", "v"));

        assertThrows(UnsupportedOperationException.class, () -> insc.presets().put("x", preset("p")));
        assertThrows(UnsupportedOperationException.class,
                () -> insc.postsets().put("x", new TransitionInscription.Postset("z", "local", null, null, null)));
        assertThrows(UnsupportedOperationException.class,
                () -> insc.emit().add(new TransitionInscription.Emit("z", null, null, null, null)));
        assertThrows(UnsupportedOperationException.class, () -> insc.metadata().put("x", "y"));
    }

    @Test
    void presetSourceMutationDoesNotLeakIntoInscription() {
        Map<String, TransitionInscription.Preset> src = new LinkedHashMap<>();
        src.put("in", preset("p-in"));
        TransitionInscription insc = new TransitionInscription(
                "t1", "task", src, null, cmdAction(), null, null, null, null, null);
        src.put("late", preset("p-late"));
        assertEquals(1, insc.presets().size(), "copyLinkedMap took a snapshot; later source edits must not leak");
    }

    // ======== isForeach ========

    @Test
    void isForeachTrueOnlyForForeachMode() {
        TransitionInscription foreach = new TransitionInscription(
                "t1", "task", null, null, cmdAction(), null, null, TransitionMode.FOREACH, null, null);
        TransitionInscription single = new TransitionInscription(
                "t2", "task", null, null, cmdAction(), null, null, TransitionMode.SINGLE, null, null);
        TransitionInscription defaulted = new TransitionInscription(
                "t3", "task", null, null, cmdAction(), null, null, null, null, null);

        assertTrue(foreach.isForeach());
        assertFalse(single.isForeach());
        assertFalse(defaulted.isForeach(), "null mode defaults to SINGLE, so not foreach");
    }

    // ======== JSON deserialization (minimal + full) ========

    @Test
    void minimalJsonAppliesAllDefaults() throws Exception {
        String json = "{\"id\":\"t-min\",\"action\":{\"type\":\"command\",\"inputPlace\":\"in\"}}";
        TransitionInscription insc = om.readValue(json, TransitionInscription.class);

        assertEquals("t-min", insc.id());
        assertEquals("task", insc.kind());
        assertTrue(insc.presets().isEmpty());
        assertTrue(insc.postsets().isEmpty());
        assertTrue(insc.emit().isEmpty());
        assertEquals(TransitionMode.SINGLE, insc.mode());
        assertTrue(insc.metadata().isEmpty());
        assertNotNull(insc.action());
        assertEquals("command", insc.action().type());
    }

    @Test
    void jsonWithForeachModeAndUnknownFieldsDeserializes() throws Exception {
        // @JsonIgnoreProperties(ignoreUnknown = true) must swallow "futureField".
        String json = "{\"id\":\"t-fe\",\"kind\":\"command\",\"mode\":\"FOREACH\","
                + "\"action\":{\"type\":\"command\",\"inputPlace\":\"in\"},\"futureField\":42}";
        TransitionInscription insc = om.readValue(json, TransitionInscription.class);

        assertEquals(TransitionMode.FOREACH, insc.mode());
        assertTrue(insc.isForeach());
    }

    // ======== nested: Preset ========

    @Test
    void presetDefaults() {
        TransitionInscription.Preset p = preset("p1");
        assertEquals(TransitionInscription.Take.FIRST, p.take(), "null take -> FIRST");
        assertTrue(p.consume(), "null consume -> true");
        assertFalse(p.isOptional(), "null optional -> false (required)");
        assertTrue(p.extensions().isEmpty());
    }

    @Test
    void presetResolveLimitFollowsTake() {
        TransitionInscription.Preset first = new TransitionInscription.Preset(
                "p", "h", "q", TransitionInscription.Take.FIRST, null, null, null, null, null, null);
        TransitionInscription.Preset all = new TransitionInscription.Preset(
                "p", "h", "q", TransitionInscription.Take.ALL, null, null, null, null, null, null);
        TransitionInscription.Preset limit = new TransitionInscription.Preset(
                "p", "h", "q", TransitionInscription.Take.LIMIT, null, null, null, null, null, null);
        TransitionInscription.Preset explicit = new TransitionInscription.Preset(
                "p", "h", "q", TransitionInscription.Take.ALL, null, 3, null, null, null, null);

        assertEquals(1, first.resolveLimit());
        assertEquals(Integer.MAX_VALUE, all.resolveLimit());
        assertEquals(1, limit.resolveLimit());
        assertEquals(3, explicit.resolveLimit(), "an explicit limit overrides the take default");
    }

    @Test
    void presetRejectsNullRequiredFields() {
        assertThrows(NullPointerException.class, () -> new TransitionInscription.Preset(
                null, "h", "q", null, null, null, null, null, null, null));
        assertThrows(NullPointerException.class, () -> new TransitionInscription.Preset(
                "p", null, "q", null, null, null, null, null, null, null));
        assertThrows(NullPointerException.class, () -> new TransitionInscription.Preset(
                "p", "h", null, null, null, null, null, null, null, null));
    }

    // ======== nested: Take.fromString ========

    @Test
    void takeFromStringMapsKnownAndDefaults() {
        assertEquals(TransitionInscription.Take.FIRST, TransitionInscription.Take.fromString("first"));
        assertEquals(TransitionInscription.Take.ALL, TransitionInscription.Take.fromString("ALL"));
        assertEquals(TransitionInscription.Take.LIMIT, TransitionInscription.Take.fromString("Limit"));
        assertEquals(TransitionInscription.Take.FIRST, TransitionInscription.Take.fromString(null));
        assertEquals(TransitionInscription.Take.FIRST, TransitionInscription.Take.fromString("  "));
        assertEquals(TransitionInscription.Take.FIRST, TransitionInscription.Take.fromString("bogus"));
    }

    // ======== nested: Postset ========

    @Test
    void postsetHasCapacity() {
        assertTrue(new TransitionInscription.Postset("p", "h", null, 5, null).hasCapacity());
        assertFalse(new TransitionInscription.Postset("p", "h", null, null, null).hasCapacity(),
                "null capacity = unlimited = no constraint");
        assertFalse(new TransitionInscription.Postset("p", "h", null, 0, null).hasCapacity(),
                "capacity 0 is not a positive constraint");
    }

    // ======== nested: Emit.appliesOn ========

    @Test
    void emitAppliesOnPhaseMatching() {
        TransitionInscription.Emit always = new TransitionInscription.Emit("to", null, null, null, null);
        TransitionInscription.Emit blank = new TransitionInscription.Emit("to", null, null, "  ", null);
        TransitionInscription.Emit onError = new TransitionInscription.Emit("to", null, null, "error", null);

        assertTrue(always.appliesOn("success"), "null when = catch-all");
        assertTrue(blank.appliesOn("anything"), "blank when = catch-all");
        assertTrue(onError.appliesOn("ERROR"), "case-insensitive phase match");
        assertFalse(onError.appliesOn("success"));
    }

    // ======== nested: Idempotency.enabled ========

    @Test
    void idempotencyEnabledOnlyWithKey() {
        assertTrue(new TransitionInscription.Idempotency("k", null, null).enabled());
        assertFalse(new TransitionInscription.Idempotency(null, "h", 1L).enabled());
        assertFalse(new TransitionInscription.Idempotency("  ", null, null).enabled(), "blank key = disabled");
    }

    // ======== nested: CommandAction + BatchingConfig + CommandExecutorRoute ========

    @Test
    void commandActionDefaults() {
        TransitionInscription.Action.CommandAction ca =
                new TransitionInscription.Action.CommandAction("in", null, null, null, null, null);
        assertEquals("command", ca.type());
        assertEquals("in", ca.inputPlace());
        assertEquals("executor", ca.groupBy(), "null groupBy -> 'executor'");
        assertNotNull(ca.batching());
        assertEquals("PER_EXECUTOR", ca.batching().mode());
        assertEquals(50, ca.batching().maxBatchSize());
        assertTrue(ca.dispatch().isEmpty(), "null dispatch -> empty list");
        assertEquals(TransitionInscription.Action.AwaitMode.ALL, ca.await(), "null await -> ALL");
        assertEquals(60000L, ca.timeoutMs(), "null timeout -> 60000ms");
    }

    @Test
    void commandActionRejectsNullInputPlace() {
        assertThrows(NullPointerException.class, () ->
                new TransitionInscription.Action.CommandAction(null, null, null, null, null, null));
    }

    @Test
    void commandExecutorRouteDefaultsChannelAndRequiresExecutor() {
        TransitionInscription.Action.CommandExecutorRoute route =
                new TransitionInscription.Action.CommandExecutorRoute("bash", null);
        assertEquals("bash", route.executor());
        assertEquals("default", route.channel(), "null channel -> 'default'");
        assertThrows(NullPointerException.class,
                () -> new TransitionInscription.Action.CommandExecutorRoute(null, "ch"));
    }

    @Test
    void defaultIdempotencyInstanceIsSharedAcrossInscriptions() {
        TransitionInscription a = new TransitionInscription(
                "a", "task", null, null, cmdAction(), null, null, null, null, null);
        TransitionInscription b = new TransitionInscription(
                "b", "task", null, null, cmdAction(), null, null, null, null, null);
        assertSame(a.idempotency(), b.idempotency(),
                "both null-idempotency inscriptions reuse the single DEFAULT_IDEMPOTENCY constant");
    }
}
