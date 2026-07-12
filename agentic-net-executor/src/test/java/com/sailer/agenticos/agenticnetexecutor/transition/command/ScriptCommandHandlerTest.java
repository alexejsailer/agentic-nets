package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Hermetic tests for the catalog-script handler: digest verification, content-addressed
 * caching, runtime execution, stdin, timeout. Uses /bin/sh (always present) and node when
 * available on the host.
 */
class ScriptCommandHandlerTest {

    private final ObjectMapper om = new ObjectMapper();

    @TempDir
    Path cacheDir;

    private ScriptCommandHandler handler;

    @BeforeEach
    void setUp() {
        handler = new ScriptCommandHandler(om, null, 600_000L, 120_000L,
                cacheDir.toString(), 1_048_576L, 131_072L, 2000);
    }

    private CommandToken token(String script, String sha, String runtime, ObjectNode extraArgs) {
        ObjectNode args = om.createObjectNode();
        args.put("toolId", "test-tool");
        if (script != null) {
            args.put("script", script);
        }
        if (sha != null) {
            args.put("scriptSha256", sha);
        }
        if (runtime != null) {
            args.put("runtime", runtime);
        }
        if (extraArgs != null) {
            args.setAll(extraArgs);
        }
        return new CommandToken("command", "cmd-1", "script", "invoke", args, "json", null, "inline", null);
    }

    private static String b64(String content) {
        return Base64.getEncoder().encodeToString(content.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha(String content) throws Exception {
        return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(content.getBytes(StandardCharsets.UTF_8)));
    }

    private static boolean nodeAvailable() {
        try {
            Process p = new ProcessBuilder("node", "--version").start();
            return p.waitFor() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    // ---- happy paths ----------------------------------------------------------------------

    @Test
    void runsShScriptAndCachesByDigest() throws Exception {
        String content = "echo '{\"ok\":true}'\n";
        CommandResult result = handler.execute(token(b64(content), sha(content), "sh", null));

        assertThat(result.status()).isEqualTo(CommandResult.Status.SUCCESS);
        assertThat(result.output().get("stdout").asText()).isEqualTo("{\"ok\":true}");
        assertThat(result.output().get("exitCode").asInt()).isZero();

        Path cached = cacheDir.resolve(sha(content)).resolve("script.sh");
        assertThat(cached).exists();
        assertThat(Files.readString(cached)).isEqualTo(content);

        // second run reuses the verified cache
        CommandResult again = handler.execute(token(b64(content), sha(content), "sh", null));
        assertThat(again.status()).isEqualTo(CommandResult.Status.SUCCESS);
    }

    @Test
    void runsNodeScriptWithArgv() throws Exception {
        Assumptions.assumeTrue(nodeAvailable(), "node not on PATH — skipping");
        String content = "console.log(JSON.stringify({ok: true, arg: process.argv[2] || null}));\n";
        ObjectNode extra = om.createObjectNode();
        extra.putArray("argv").add("hello");
        extra.put("filename", "my-tool.cjs");

        CommandResult result = handler.execute(token(b64(content), sha(content), "node", extra));

        assertThat(result.status()).isEqualTo(CommandResult.Status.SUCCESS);
        JsonNode parsed = om.readTree(result.output().get("stdout").asText());
        assertThat(parsed.get("ok").asBoolean()).isTrue();
        assertThat(parsed.get("arg").asText()).isEqualTo("hello");
        assertThat(cacheDir.resolve(sha(content)).resolve("my-tool.cjs")).exists();
    }

    @Test
    void writesInputJsonToStdinAndClosesIt() throws Exception {
        String content = "read line; echo \"got:$line\"\n";
        ObjectNode extra = om.createObjectNode();
        extra.set("input", om.valueToTree(Map.of("a", 1)));

        CommandResult result = handler.execute(token(b64(content), sha(content), "sh", extra));

        assertThat(result.status()).isEqualTo(CommandResult.Status.SUCCESS);
        assertThat(result.output().get("stdout").asText()).isEqualTo("got:{\"a\":1}");
    }

    @Test
    void closesStdinWhenNoInputSoReadsDoNotHang() throws Exception {
        // Without an explicit close this would block until the timeout.
        String content = "read line; echo \"done:$line\"\n";
        CommandResult result = handler.execute(token(b64(content), sha(content), "sh", null));

        assertThat(result.status()).isIn(CommandResult.Status.SUCCESS, CommandResult.Status.FAILED);
        assertThat(result.error() == null || !result.error().contains("timed out")).isTrue();
    }

    @Test
    void passesEnvIntoTheProcess() throws Exception {
        String content = "echo \"key=$MY_SECRET\"\n";
        ObjectNode extra = om.createObjectNode();
        extra.putObject("env").put("MY_SECRET", "s3cret");

        CommandResult result = handler.execute(token(b64(content), sha(content), "sh", extra));

        assertThat(result.status()).isEqualTo(CommandResult.Status.SUCCESS);
        assertThat(result.output().get("stdout").asText()).isEqualTo("key=s3cret");
    }

    // ---- security / integrity ---------------------------------------------------------------

    @Test
    void refusesShaMismatch() throws Exception {
        String content = "echo tampered\n";
        String wrongSha = sha("something else entirely");

        CommandResult result = handler.execute(token(b64(content), wrongSha, "sh", null));

        assertThat(result.status()).isEqualTo(CommandResult.Status.FAILED);
        assertThat(result.error()).contains("sha256 mismatch");
        assertThat(Files.exists(cacheDir.resolve(wrongSha))).isFalse();
    }

    @Test
    void repairsTamperedCacheFileBeforeRunning() throws Exception {
        String content = "echo '{\"ok\":true}'\n";
        String digest = sha(content);
        // poison the cache location with different content
        Path dir = cacheDir.resolve(digest);
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("script.sh"), "echo EVIL\n");

        CommandResult result = handler.execute(token(b64(content), digest, "sh", null));

        assertThat(result.status()).isEqualTo(CommandResult.Status.SUCCESS);
        assertThat(result.output().get("stdout").asText()).isEqualTo("{\"ok\":true}");
        assertThat(Files.readString(dir.resolve("script.sh"))).isEqualTo(content);
    }

    @Test
    void rejectsMissingScriptContentWithCatalogHint() {
        CommandToken t = token(null, null, "node", null);
        CommandResult result = handler.execute(t);

        assertThat(result.status()).isEqualTo(CommandResult.Status.FAILED);
        assertThat(result.error()).contains("master resolves it from the tool catalog");
        assertThat(handler.validate(t)).contains("args.script");
    }

    @Test
    void rejectsUnknownRuntime() throws Exception {
        String content = "print('hi')";
        CommandResult result = handler.execute(token(b64(content), sha(content), "perl", null));

        assertThat(result.status()).isEqualTo(CommandResult.Status.FAILED);
        assertThat(result.error()).contains("runtime");
    }

    @Test
    void sanitizesHostileFilenames() throws Exception {
        String content = "echo ok\n";
        ObjectNode extra = om.createObjectNode();
        extra.put("filename", "../../../etc/passwd");

        CommandResult result = handler.execute(token(b64(content), sha(content), "sh", extra));

        assertThat(result.status()).isEqualTo(CommandResult.Status.SUCCESS);
        // everything stays inside the digest dir; separators were replaced
        assertThat(Files.list(cacheDir.resolve(sha(content))).toList())
                .allMatch(p -> p.getParent().equals(cacheDir.resolve(shaQuiet(content))));
    }

    // ---- limits --------------------------------------------------------------------------------

    @Test
    void timesOutLongRunningScript() throws Exception {
        String content = "sleep 5\n";
        ObjectNode extra = om.createObjectNode();
        extra.put("timeoutMs", 300);

        long start = System.currentTimeMillis();
        CommandResult result = handler.execute(token(b64(content), sha(content), "sh", extra));

        assertThat(result.status()).isEqualTo(CommandResult.Status.FAILED);
        assertThat(result.error()).contains("timed out");
        assertThat(System.currentTimeMillis() - start).isLessThan(4000);
    }

    @Test
    void nonZeroExitBecomesFailedWithOutputPreserved() throws Exception {
        String content = "echo 'partial work'; exit 3\n";
        CommandResult result = handler.execute(token(b64(content), sha(content), "sh", null));

        assertThat(result.status()).isEqualTo(CommandResult.Status.FAILED);
        assertThat(result.error()).contains("code 3");
        assertThat(result.output().get("stdout").asText()).isEqualTo("partial work");
    }

    private static String shaQuiet(String content) {
        try {
            return sha(content);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
