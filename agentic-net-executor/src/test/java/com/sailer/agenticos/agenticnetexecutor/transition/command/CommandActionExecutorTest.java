package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit tests for CommandActionExecutor's token preprocessing methods.
 */
class CommandActionExecutorTest {

    private CommandActionExecutor executor;
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        // dispatcher is not needed for preprocessing tests
        executor = new CommandActionExecutor(null, objectMapper);
    }

    @Test
    void reassembleFlatArgs_mergesExistingArgsWithFlatProperties() throws Exception {
        // Token has both a nested args object (with "command") and flat args.workingDir
        ObjectNode token = objectMapper.createObjectNode();
        token.put("kind", "command");
        token.put("id", "cmd-001");
        token.put("executor", "bash");
        token.put("command", "exec");
        token.put("expect", "text");

        ObjectNode existingArgs = objectMapper.createObjectNode();
        existingArgs.put("command", "echo hello");
        token.set("args", existingArgs);

        // Flat property that should be merged into args
        token.put("args.workingDir", "/tmp");
        token.put("args.timeoutMs", "30000");

        JsonNode result = invokeReassembleFlatArgs(token);

        assertThat(result.get("args").get("command").asText()).isEqualTo("echo hello");
        assertThat(result.get("args").get("workingDir").asText()).isEqualTo("/tmp");
        assertThat(result.get("args").get("timeoutMs").asLong()).isEqualTo(30000L);
        assertThat(result.get("kind").asText()).isEqualTo("command");
        assertThat(result.get("executor").asText()).isEqualTo("bash");
    }

    @Test
    void reassembleFlatArgs_flatArgsOverrideExistingOnConflict() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-002");
        token.put("executor", "bash");
        token.put("command", "exec");

        ObjectNode existingArgs = objectMapper.createObjectNode();
        existingArgs.put("command", "old-command");
        token.set("args", existingArgs);

        // Flat property overrides existing
        token.put("args.command", "new-command");

        JsonNode result = invokeReassembleFlatArgs(token);

        assertThat(result.get("args").get("command").asText()).isEqualTo("new-command");
    }

    @Test
    void reassembleFlatArgs_onlyFlatArgs_assemblesCorrectly() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-003");
        token.put("executor", "bash");
        token.put("command", "exec");
        token.put("args.command", "ls -la");
        token.put("args.timeoutMs", "60000");

        JsonNode result = invokeReassembleFlatArgs(token);

        assertThat(result.get("args").get("command").asText()).isEqualTo("ls -la");
        assertThat(result.get("args").get("timeoutMs").asLong()).isEqualTo(60000L);
    }

    @Test
    void reassembleFlatArgs_noFlatArgs_returnsOriginal() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-004");
        token.put("executor", "bash");
        token.put("command", "exec");

        ObjectNode args = objectMapper.createObjectNode();
        args.put("command", "echo test");
        token.set("args", args);

        JsonNode result = invokeReassembleFlatArgs(token);

        // Should return original unchanged
        assertThat(result).isSameAs(token);
        assertThat(result.get("args").get("command").asText()).isEqualTo("echo test");
    }

    // --- ensureArgsCommand tests ---

    @Test
    void ensureArgsCommand_argsCommandPresent_returnsOriginal() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-010");
        token.put("executor", "bash");
        token.put("command", "exec");
        ObjectNode args = objectMapper.createObjectNode();
        args.put("command", "echo hello");
        token.set("args", args);

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result).isSameAs(token);
    }

    @Test
    void ensureArgsCommand_shellCommandField_movedToArgsCommand() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-011");
        token.put("executor", "bash");
        token.put("command", "exec");
        token.put("shellCommand", "ls -la /tmp");

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result.get("args").get("command").asText()).isEqualTo("ls -la /tmp");
        assertThat(result.has("shellCommand")).isFalse();
    }

    @Test
    void ensureArgsCommand_cmdField_movedToArgsCommand() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-012");
        token.put("executor", "bash");
        token.put("command", "exec");
        token.put("cmd", "whoami");

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result.get("args").get("command").asText()).isEqualTo("whoami");
        assertThat(result.has("cmd")).isFalse();
    }

    @Test
    void ensureArgsCommand_argsExistsButMissingCommand_preservesExistingArgs() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-013");
        token.put("executor", "bash");
        token.put("command", "exec");
        token.put("shellCommand", "date");
        ObjectNode args = objectMapper.createObjectNode();
        args.put("workingDir", "/tmp");
        args.put("timeoutMs", 30000);
        token.set("args", args);

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result.get("args").get("command").asText()).isEqualTo("date");
        assertThat(result.get("args").get("workingDir").asText()).isEqualTo("/tmp");
        assertThat(result.get("args").get("timeoutMs").asInt()).isEqualTo(30000);
    }

    @Test
    void ensureArgsCommand_nonBashExecutor_returnsOriginal() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-014");
        token.put("executor", "fs");
        token.put("command", "readFile");

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result).isSameAs(token);
    }

    @Test
    void ensureArgsCommand_noAlternativeFields_returnsOriginal() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-015");
        token.put("executor", "bash");
        token.put("command", "exec");
        // No args and no alternative fields — returns original (will fail validation later)

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result).isSameAs(token);
    }

    @Test
    void ensureArgsCommand_shellCommandInTopLevelCommand_normalizedToExec() throws Exception {
        // LLM puts actual shell command in top-level 'command' instead of using "exec" + args
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-016");
        token.put("executor", "bash");
        token.put("command", "echo hello world");

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result.get("command").asText()).isEqualTo("exec");
        assertThat(result.get("args").get("command").asText()).isEqualTo("echo hello world");
    }

    @Test
    void ensureArgsCommand_shellCommandInTopLevelCommand_preservesExistingArgs() throws Exception {
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-017");
        token.put("executor", "bash");
        token.put("command", "ls -la /tmp");
        ObjectNode args = objectMapper.createObjectNode();
        args.put("workingDir", "/home");
        args.put("timeoutMs", 30000);
        token.set("args", args);

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result.get("command").asText()).isEqualTo("exec");
        assertThat(result.get("args").get("command").asText()).isEqualTo("ls -la /tmp");
        assertThat(result.get("args").get("workingDir").asText()).isEqualTo("/home");
        assertThat(result.get("args").get("timeoutMs").asInt()).isEqualTo(30000);
    }

    @Test
    void ensureArgsCommand_argsAsPlainString_treatedAsCommand() throws Exception {
        // LLM puts shell command as plain string in args field
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-018");
        token.put("executor", "bash");
        token.put("command", "exec");
        token.put("args", "echo hello world");

        JsonNode result = invokeEnsureArgsCommand(token);

        assertThat(result.get("args").get("command").asText()).isEqualTo("echo hello world");
    }

    @Test
    void ensureArgsCommand_argsAsJsonString_notTreatedAsPlainCommand() throws Exception {
        // args is a stringified JSON — should NOT be treated as a plain command string
        // (parseStringifiedJsonFields handles this case instead)
        ObjectNode token = objectMapper.createObjectNode();
        token.put("id", "cmd-019");
        token.put("executor", "bash");
        token.put("command", "exec");
        token.put("args", "{\"command\":\"echo hello\"}");

        JsonNode result = invokeEnsureArgsCommand(token);

        // Should pass through unchanged (stringified JSON is handled by parseStringifiedJsonFields)
        assertThat(result.get("args").isTextual()).isTrue();
    }

    private JsonNode invokeReassembleFlatArgs(JsonNode tokenData) throws Exception {
        Method method = CommandActionExecutor.class.getDeclaredMethod("reassembleFlatArgs", JsonNode.class);
        method.setAccessible(true);
        return (JsonNode) method.invoke(executor, tokenData);
    }

    private JsonNode invokeEnsureArgsCommand(JsonNode tokenData) throws Exception {
        Method method = CommandActionExecutor.class.getDeclaredMethod("ensureArgsCommand", JsonNode.class);
        method.setAccessible(true);
        return (JsonNode) method.invoke(executor, tokenData);
    }
}
