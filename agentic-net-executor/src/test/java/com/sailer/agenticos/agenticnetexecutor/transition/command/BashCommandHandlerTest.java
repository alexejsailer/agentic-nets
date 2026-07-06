package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link BashCommandHandler} — the executor's shell command handler had NO test despite
 * running arbitrary commands for every {@code kind:command} transition. These pin the contract the rest of the
 * platform relies on: exit codes map to SUCCESS/FAILED, stdout and stderr are kept SEPARATE when
 * {@code captureStderr=false} (and merged when true), a requested timeout is honoured AND capped by the
 * configured max, script mode runs multi-line scripts, env vars reach the process, and validation rejects
 * malformed tokens. Runs real local bash (hermetic, no network).
 */
class BashCommandHandlerTest {

    private final ObjectMapper om = new ObjectMapper();
    // blobStoreClient is only touched for binaryUrn results or when a stream exceeds the offload
    // threshold; these tokens request neither and produce tiny output → null is safe.
    private final BashCommandHandler handler = new BashCommandHandler(om, null, 600_000L, 131072L, 2000, "", "");

    private CommandToken exec(ObjectNode args) {
        return new CommandToken("command", "cmd-1", "bash", "exec", args, "json", null, null, null);
    }

    private CommandToken script(ObjectNode args) {
        return new CommandToken("command", "cmd-1", "bash", "script", args, "json", null, null, null);
    }

    private ObjectNode args() {
        return om.createObjectNode();
    }

    @Test
    void execCapturesStdoutAndExitZero() {
        CommandResult res = handler.execute(exec(args().put("command", "echo hello-world")));
        assertEquals(CommandResult.Status.SUCCESS, res.status());
        JsonNode out = res.output();
        assertNotNull(out);
        assertEquals(0, out.get("exitCode").asInt());
        assertTrue(out.get("success").asBoolean());
        assertTrue(out.get("stdout").asText().contains("hello-world"), "stdout should carry the echoed text");
    }

    @Test
    void nonZeroExitIsFailedWithExitCodePreserved() {
        CommandResult res = handler.execute(exec(args().put("command", "exit 3")));
        assertEquals(CommandResult.Status.FAILED, res.status(), "a non-zero exit must be a FAILED result");
        assertEquals(3, res.output().get("exitCode").asInt(), "the real exit code must be preserved");
        assertNotNull(res.error());
        assertTrue(res.error().contains("3"), "error should mention the exit code");
    }

    @Test
    void captureStderrFalse_keepsStdoutAndStderrSeparate() {
        // Regression guard for the stdout/stderr separation feature: with captureStderr=false the two streams
        // must NOT be merged, so downstream transitions can distinguish diagnostic noise from real output.
        ObjectNode a = args();
        a.put("command", "echo TO_OUT; echo TO_ERR 1>&2");
        a.put("captureStderr", false);
        CommandResult res = handler.execute(exec(a));

        assertEquals(CommandResult.Status.SUCCESS, res.status());
        assertEquals("TO_OUT", res.output().get("stdout").asText(), "stdout must contain only the stdout line");
        assertEquals("TO_ERR", res.output().get("stderr").asText(), "stderr must be captured separately");
    }

    @Test
    void captureStderrTrueByDefault_mergesStderrIntoStdout() {
        // Default (captureStderr omitted → true) redirects stderr into stdout: the error line surfaces in
        // stdout and the separate stderr field is empty.
        CommandResult res = handler.execute(exec(args().put("command", "echo TO_OUT; echo TO_ERR 1>&2")));

        assertEquals(CommandResult.Status.SUCCESS, res.status());
        String stdout = res.output().get("stdout").asText();
        assertTrue(stdout.contains("TO_OUT") && stdout.contains("TO_ERR"),
                "with the default merge, both lines land on stdout");
        assertEquals("", res.output().get("stderr").asText(), "the merged stderr field should be empty");
    }

    @Test
    void scriptModeRunsMultiLineScript() {
        CommandResult res = handler.execute(script(args().put("script", "echo line-one\necho line-two")));
        assertEquals(CommandResult.Status.SUCCESS, res.status());
        String stdout = res.output().get("stdout").asText();
        assertTrue(stdout.contains("line-one") && stdout.contains("line-two"),
                "a multi-line script should run every line");
    }

    @Test
    void envVariablesReachTheProcess() {
        ObjectNode a = args();
        a.put("command", "echo value-is-$MY_FLAG");
        a.set("env", om.createObjectNode().put("MY_FLAG", "wired-through"));
        CommandResult res = handler.execute(exec(a));

        assertEquals(CommandResult.Status.SUCCESS, res.status());
        assertTrue(res.output().get("stdout").asText().contains("value-is-wired-through"),
                "the env var must be visible to the shell");
    }

    @Test
    void invalidWorkingDirIsRejected() {
        ObjectNode a = args();
        a.put("command", "echo hi");
        a.put("workingDir", "/no/such/directory/" + System.nanoTime());
        CommandResult res = handler.execute(exec(a));

        assertEquals(CommandResult.Status.FAILED, res.status());
        assertNotNull(res.error());
        assertTrue(res.error().toLowerCase().contains("working directory"),
                "the error should name the missing working directory");
    }

    @Test
    void validateRejectsExecMissingCommand() {
        String err = handler.validate(exec(args())); // no "command" field
        assertNotNull(err, "exec without a command must not validate");
        assertTrue(err.contains("command"), "validation error should name the missing 'command' field");
    }

    @Test
    void validateRejectsScriptMissingScript() {
        String err = handler.validate(script(args())); // no "script" field
        assertNotNull(err, "script without a script body must not validate");
        assertTrue(err.contains("script"), "validation error should name the missing 'script' field");
    }

    @Test
    void requestedTimeoutIsEnforced() {
        ObjectNode a = args();
        a.put("command", "sleep 30");
        a.put("timeoutMs", 400);
        long start = System.currentTimeMillis();
        CommandResult res = handler.execute(exec(a));
        long elapsed = System.currentTimeMillis() - start;

        assertEquals(CommandResult.Status.FAILED, res.status(), "a command past its timeout must fail");
        assertNotNull(res.error());
        assertTrue(res.error().toLowerCase().contains("timed out"), "error should say it timed out");
        assertTrue(elapsed < 15_000, "the 30s sleep must be killed near the 400ms timeout, not run to completion");
    }

    @Test
    void timeoutIsCappedByConfiguredMaximum() {
        // A handler with a tiny max timeout must clamp an absurdly large per-command timeout down to the max,
        // so a runaway command can't request an unbounded wait (Math.min(timeoutMs, maxTimeoutMs)).
        BashCommandHandler capped = new BashCommandHandler(om, null, 400L, 131072L, 2000, "", "");
        ObjectNode a = args();
        a.put("command", "sleep 30");
        a.put("timeoutMs", 999_999_999L); // far above the 400ms cap
        long start = System.currentTimeMillis();
        CommandResult res = capped.execute(exec(a));
        long elapsed = System.currentTimeMillis() - start;

        assertEquals(CommandResult.Status.FAILED, res.status());
        assertTrue(res.error().toLowerCase().contains("timed out"));
        assertTrue(elapsed < 15_000, "the requested timeout must be clamped to the configured max, not honoured");
        assertFalse(res.isSuccess());
    }
}
