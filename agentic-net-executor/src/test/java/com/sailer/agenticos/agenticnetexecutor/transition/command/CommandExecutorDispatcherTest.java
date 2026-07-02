package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link CommandExecutorDispatcher} — the routing spine that maps a command token's executor type to a
 * {@link CommandHandler}. Untested, yet every command transition passes through it. Uses an in-process fake
 * handler (no real bash/fs) to pin the contract: handlers register by executor type with higher priority winning
 * a conflict; execution routes to the right handler, validates first (short-circuiting on error), and fails
 * cleanly for an unknown executor; batches group by executor; and token parsing/validation reject malformed input.
 */
class CommandExecutorDispatcherTest {

    private final ObjectMapper om = new ObjectMapper();

    /** Minimal in-process handler so routing can be verified without touching the shell or filesystem. */
    static class FakeHandler implements CommandHandler {
        final String type;
        final int priority;
        final String validationError;   // null = valid
        final boolean succeed;
        int executeCount = 0;

        FakeHandler(String type, int priority, String validationError, boolean succeed) {
            this.type = type;
            this.priority = priority;
            this.validationError = validationError;
            this.succeed = succeed;
        }

        @Override public String getExecutorType() { return type; }
        @Override public Set<String> getSupportedCommands() { return Set.of("do"); }
        @Override public int getPriority() { return priority; }
        @Override public String validate(CommandToken token) { return validationError; }

        @Override
        public CommandResult execute(CommandToken token) {
            executeCount++;
            ObjectNode out = new ObjectMapper().createObjectNode().put("handledBy", type);
            return succeed
                    ? CommandResult.success(token.id(), out, 1L, token.getMetaAsMap())
                    : CommandResult.failed(token.id(), "boom", 1L, token.getMetaAsMap());
        }
    }

    private CommandExecutorDispatcher dispatcher(CommandHandler... handlers) {
        return new CommandExecutorDispatcher(List.of(handlers), om);
    }

    private CommandToken token(String id, String executor) {
        return new CommandToken("command", id, executor, "do", null, "json", null, null, null);
    }

    @Test
    void supportedExecutorsReflectRegisteredHandlers() {
        CommandExecutorDispatcher d = dispatcher(new FakeHandler("fs", 0, null, true),
                new FakeHandler("bash", 0, null, true));
        assertEquals(Set.of("fs", "bash"), d.getSupportedExecutors());
        assertTrue(d.supportsExecutor("fs"));
        assertFalse(d.supportsExecutor("mcp"));
    }

    @Test
    void higherPriorityHandlerWinsOnExecutorConflict() {
        FakeHandler low = new FakeHandler("dup", 1, null, true);
        FakeHandler high = new FakeHandler("dup", 9, null, true);
        CommandExecutorDispatcher d = dispatcher(low, high);
        CommandHandler chosen = d.getHandler("dup").orElseThrow();
        assertEquals(9, ((FakeHandler) chosen).priority, "the higher-priority handler must win the type conflict");
    }

    @Test
    void executeCommandRoutesToMatchingHandler() {
        FakeHandler fs = new FakeHandler("fs", 0, null, true);
        CommandResult res = dispatcher(fs).executeCommand(token("c1", "fs"));
        assertEquals(CommandResult.Status.SUCCESS, res.status());
        assertEquals("fs", res.output().get("handledBy").asText());
        assertEquals(1, fs.executeCount);
    }

    @Test
    void executeCommandWithUnknownExecutorFailsCleanly() {
        CommandResult res = dispatcher(new FakeHandler("fs", 0, null, true)).executeCommand(token("c1", "mcp"));
        assertEquals(CommandResult.Status.FAILED, res.status());
        assertTrue(res.error().contains("No handler for executor: mcp"));
    }

    @Test
    void executeCommandShortCircuitsOnValidationError() {
        FakeHandler fs = new FakeHandler("fs", 0, "bad args", true);
        CommandResult res = dispatcher(fs).executeCommand(token("c1", "fs"));
        assertEquals(CommandResult.Status.FAILED, res.status());
        assertEquals("bad args", res.error());
        assertEquals(0, fs.executeCount, "a token that fails validation must never reach execute()");
    }

    @Test
    void executeBatchGroupsByExecutorAndRoutesEach() {
        FakeHandler fs = new FakeHandler("fs", 0, null, true);
        FakeHandler bash = new FakeHandler("bash", 0, null, true);
        List<BatchResult> batches = dispatcher(fs, bash).executeBatch(
                List.of(token("a", "fs"), token("b", "fs"), token("c", "bash")), "batch");

        assertEquals(2, batches.size(), "one batch per distinct executor");
        int total = batches.stream().mapToInt(BatchResult::totalCount).sum();
        assertEquals(3, total);
        assertEquals(2, fs.executeCount);
        assertEquals(1, bash.executeCount);
    }

    @Test
    void executeBatchWithUnknownExecutorProducesFailedBatch() {
        List<BatchResult> batches = dispatcher(new FakeHandler("fs", 0, null, true))
                .executeBatch(List.of(token("a", "mcp")), "batch");
        assertEquals(1, batches.size());
        assertTrue(batches.get(0).hasFailures());
        assertEquals("mcp", batches.get(0).executor());
    }

    @Test
    void executeBatchEmptyReturnsEmptyList() {
        assertTrue(dispatcher(new FakeHandler("fs", 0, null, true)).executeBatch(List.of(), "batch").isEmpty());
    }

    @Test
    void executeParallelRunsEveryToken() throws Exception {
        FakeHandler fs = new FakeHandler("fs", 0, null, true);
        FakeHandler bash = new FakeHandler("bash", 0, null, true);
        List<CommandResult> results = dispatcher(fs, bash)
                .executeParallel(List.of(token("a", "fs"), token("b", "bash"))).get();
        assertEquals(2, results.size());
        assertTrue(results.stream().allMatch(r -> r.status() == CommandResult.Status.SUCCESS));
    }

    @Test
    void parseTokenParsesValidJsonAndRejectsInvalid() {
        ObjectNode good = om.createObjectNode();
        good.put("kind", "command");
        good.put("id", "c1");
        good.put("executor", "bash");
        good.put("command", "do");
        CommandToken parsed = dispatcher(new FakeHandler("bash", 0, null, true)).parseToken(good);
        assertEquals("c1", parsed.id());
        assertEquals("bash", parsed.executor());

        ObjectNode missingId = om.createObjectNode();
        missingId.put("kind", "command");
        missingId.put("executor", "bash");
        missingId.put("command", "do");
        assertThrows(IllegalArgumentException.class,
                () -> dispatcher(new FakeHandler("bash", 0, null, true)).parseToken(missingId));
    }

    @Test
    void parseTokensRejectsNonArray() {
        assertThrows(IllegalArgumentException.class,
                () -> dispatcher(new FakeHandler("bash", 0, null, true)).parseTokens(om.createObjectNode()));
    }

    @Test
    void validateTokenReportsInvalidTokenUnknownExecutorAndDelegates() {
        CommandExecutorDispatcher d = dispatcher(new FakeHandler("fs", 0, null, true),
                new FakeHandler("bash", 0, "bad", true));

        // kind != "command" → CommandToken.isValid() is false
        CommandToken malformed = new CommandToken("other", "c1", "fs", "do", null, "json", null, null, null);
        assertTrue(d.validateToken(malformed).contains("Invalid command token"));

        assertTrue(d.validateToken(token("c1", "zzz")).contains("No handler for executor: zzz"));

        assertNull(d.validateToken(token("c1", "fs")), "a valid token on a handler that accepts it → null");
        assertEquals("bad", d.validateToken(token("c1", "bash")), "delegates to the handler's own validation");
    }

    @Test
    void getHandlerReturnsEmptyForUnknownExecutor() {
        assertTrue(dispatcher(new FakeHandler("fs", 0, null, true)).getHandler("nope").isEmpty());
    }
}
