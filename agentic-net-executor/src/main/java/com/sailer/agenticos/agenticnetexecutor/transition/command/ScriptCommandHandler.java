package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetexecutor.blob.BlobStoreClient;
import com.sailer.agenticos.agenticnetexecutor.blob.BlobUploadResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Command handler for catalog-managed script artifacts (executor type {@code script}).
 *
 * <p>A command token references a tool-catalog script by {@code args.toolId}. The MASTER
 * resolves that reference at FIRE time and inlines the artifact into the token
 * ({@code args.script} base64 + {@code args.scriptSha256} + {@code args.runtime} +
 * {@code args.filename}) — the executor deliberately fetches nothing itself, so egress-only
 * gateway deployments keep working with the scope-limited executor JWT. This handler
 * re-verifies the digest end to end, materializes the script under a content-addressed cache
 * in the persistent workspace, and runs it with the declared runtime.</p>
 *
 * <p>This replaces the {@code docker cp /opt/*.cjs} era: the artifact survives container
 * recreation (cache lives in the {@code /workspace} volume) and can never drift from what was
 * registered — content that does not hash to the pinned digest is refused, including a cached
 * file that was modified on disk.</p>
 *
 * Supported command: {@code invoke} with args:
 * <pre>
 *   toolId        catalog id (authoring surface; master injects the rest)
 *   script        base64 content   (master-injected)
 *   scriptSha256  pinned digest    (master-injected, from the catalog binding)
 *   runtime       node | sh | bash | python3
 *   filename?     cache filename   (master-injected from the binding)
 *   argv?         string array appended after the script path
 *   env?          extra environment (credentials arrive here via the standard injection)
 *   input?        JSON value written to stdin (stdin is always closed either way)
 *   workingDir?   optional cwd (must exist)
 *   timeoutMs?    default executor.command.script.timeout, capped by max-timeout-ms
 * </pre>
 */
@Component
public class ScriptCommandHandler implements CommandHandler {

    private static final Logger logger = LoggerFactory.getLogger(ScriptCommandHandler.class);

    private static final String EXECUTOR_TYPE = "script";
    private static final Set<String> SUPPORTED_COMMANDS = Set.of("invoke");
    private static final Pattern SHA256_HEX = Pattern.compile("^[a-f0-9]{64}$");
    private static final Map<String, String> RUNTIME_BINARIES = Map.of(
            "node", "node",
            "sh", "/bin/sh",
            "bash", "bash",
            "python3", "python3");

    private final ObjectMapper objectMapper;
    private final BlobStoreClient blobStoreClient;
    private final long maxTimeoutMs;
    private final long defaultTimeoutMs;
    private final Path configuredCacheRoot;
    private final long maxScriptBytes;
    private final long stdoutMaxInlineBytes;
    private final int stdoutPreviewChars;

    private volatile Path cacheRoot; // resolved lazily: /workspace may not exist on native dev Macs

    public ScriptCommandHandler(ObjectMapper objectMapper, BlobStoreClient blobStoreClient,
            @Value("${executor.command.max-timeout-ms:600000}") long maxTimeoutMs,
            @Value("${executor.command.script.timeout:120000}") long defaultTimeoutMs,
            @Value("${executor.command.script.cache-dir:/workspace/.agenticos/scripts}") String cacheDir,
            @Value("${executor.command.script.max-bytes:1048576}") long maxScriptBytes,
            @Value("${executor.command.stdout.max-inline-bytes:131072}") long stdoutMaxInlineBytes,
            @Value("${executor.command.stdout.preview-chars:2000}") int stdoutPreviewChars) {
        this.objectMapper = objectMapper;
        this.blobStoreClient = blobStoreClient;
        this.maxTimeoutMs = maxTimeoutMs > 0 ? maxTimeoutMs : 600_000L;
        this.defaultTimeoutMs = defaultTimeoutMs > 0 ? defaultTimeoutMs : 120_000L;
        this.configuredCacheRoot = Path.of(cacheDir);
        this.maxScriptBytes = maxScriptBytes > 0 ? maxScriptBytes : 1_048_576L;
        this.stdoutMaxInlineBytes = stdoutMaxInlineBytes;
        this.stdoutPreviewChars = stdoutPreviewChars > 0 ? stdoutPreviewChars : 2000;
        logger.info("Script command handler ready: cache={}, runtimes={}", cacheDir, RUNTIME_BINARIES.keySet());
    }

    @Override
    public String getExecutorType() {
        return EXECUTOR_TYPE;
    }

    @Override
    public Set<String> getSupportedCommands() {
        return SUPPORTED_COMMANDS;
    }

    @Override
    public String validate(CommandToken token) {
        JsonNode args = parseArgsIfStringified(token.args());
        return validateArgs(args);
    }

    @Override
    public CommandResult execute(CommandToken token) {
        long start = System.currentTimeMillis();
        try {
            JsonNode args = parseArgsIfStringified(token.args());
            String error = validateArgs(args);
            if (error != null) {
                throw new IllegalArgumentException(error);
            }

            byte[] content = Base64.getDecoder().decode(args.get("script").asText());
            String declared = args.get("scriptSha256").asText().toLowerCase(Locale.ROOT);
            String actual = sha256Hex(content);
            if (!actual.equals(declared)) {
                throw new IllegalStateException("Script sha256 mismatch for tool '" + text(args, "toolId", "?")
                        + "': catalog pins " + declared + " but shipped content hashes to " + actual
                        + " — refusing to run unverified content");
            }
            if (content.length > maxScriptBytes) {
                throw new IllegalArgumentException("Script exceeds executor.command.script.max-bytes (" + maxScriptBytes + ")");
            }

            String runtime = args.get("runtime").asText().toLowerCase(Locale.ROOT);
            Path scriptPath = materialize(content, declared, text(args, "filename", null), runtime);

            List<String> cmd = new ArrayList<>();
            cmd.add(RUNTIME_BINARIES.get(runtime));
            cmd.add(scriptPath.toString());
            JsonNode argv = args.get("argv");
            if (argv != null && argv.isArray()) {
                argv.forEach(a -> cmd.add(a.asText()));
            }

            ProcessBuilder pb = new ProcessBuilder(cmd);
            String workingDir = text(args, "workingDir", null);
            if (workingDir != null && !workingDir.isBlank()) {
                File dir = new File(workingDir);
                if (!dir.isDirectory()) {
                    throw new IllegalArgumentException("Working directory does not exist: " + workingDir);
                }
                pb.directory(dir);
            }
            JsonNode env = args.get("env");
            if (env != null && env.isObject()) {
                env.fields().forEachRemaining(e -> {
                    if (e.getValue().isValueNode()) {
                        pb.environment().put(e.getKey(), e.getValue().asText());
                    }
                });
            }

            long timeoutMs = Math.min(
                    args.has("timeoutMs") ? args.get("timeoutMs").asLong(defaultTimeoutMs) : defaultTimeoutMs,
                    maxTimeoutMs);
            byte[] stdin = args.has("input") && !args.get("input").isNull()
                    ? objectMapper.writeValueAsBytes(args.get("input"))
                    : null;

            ObjectNode output = runProcess(pb, timeoutMs,
                    runtime + " " + scriptPath.getFileName() + " (tool " + text(args, "toolId", "?") + ")",
                    stdin, token);

            long durationMs = System.currentTimeMillis() - start;
            boolean success = output.has("success") && output.get("success").asBoolean(false);
            if (success) {
                return CommandResult.success(token.id(), output, durationMs, token.getMetaAsMap());
            }
            int exitCode = output.has("exitCode") ? output.get("exitCode").asInt() : -1;
            return new CommandResult(token.id(), CommandResult.Status.FAILED, output,
                    "Script exited with code " + exitCode, durationMs,
                    java.time.Instant.now(), token.getMetaAsMap());

        } catch (Exception e) {
            long durationMs = System.currentTimeMillis() - start;
            logger.error("script:invoke failed: {}", e.getMessage());
            return CommandResult.failed(token.id(), e.getMessage(), durationMs, token.getMetaAsMap());
        }
    }

    // ---- validation --------------------------------------------------------------------------

    private String validateArgs(JsonNode args) {
        if (args == null || !args.isObject()) {
            return "script:invoke requires an args object";
        }
        if (!(args.get("toolId") instanceof JsonNode t) || !t.isTextual() || t.asText().isBlank()) {
            return "args.toolId is required (the tool-catalog script id)";
        }
        if (!args.hasNonNull("script") || !args.get("script").isTextual() || args.get("script").asText().isBlank()) {
            return "args.script (base64 content) is missing — the master resolves it from the tool catalog at FIRE time; "
                    + "is there an approved catalog entry for toolId '" + args.get("toolId").asText() + "'?";
        }
        JsonNode sha = args.get("scriptSha256");
        if (sha == null || !sha.isTextual() || !SHA256_HEX.matcher(sha.asText().toLowerCase(Locale.ROOT)).matches()) {
            return "args.scriptSha256 must be a 64-char hex sha256 (master-injected from the catalog binding)";
        }
        JsonNode runtime = args.get("runtime");
        if (runtime == null || !runtime.isTextual()
                || !RUNTIME_BINARIES.containsKey(runtime.asText().toLowerCase(Locale.ROOT))) {
            return "args.runtime must be one of " + RUNTIME_BINARIES.keySet();
        }
        return null;
    }

    // ---- content-addressed cache ---------------------------------------------------------------

    private Path materialize(byte[] content, String sha, String requestedName, String runtime) throws Exception {
        Path dir = ensureCacheRoot().resolve(sha);
        Files.createDirectories(dir);
        String ext = switch (runtime) {
            case "node" -> ".cjs";
            case "python3" -> ".py";
            default -> ".sh";
        };
        String name = requestedName == null || requestedName.isBlank()
                ? "script" + ext
                : requestedName.replaceAll("[^A-Za-z0-9._-]", "-");
        Path target = dir.resolve(name);

        // The dir is named by the digest, but re-verify the cached bytes anyway — a partial
        // write from a crash (or manual tampering in the volume) must not survive silently.
        if (Files.exists(target) && sha256Hex(Files.readAllBytes(target)).equals(sha)) {
            return target;
        }
        Path tmp = Files.createTempFile(dir, ".tmp-", name);
        Files.write(tmp, content);
        try {
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (FileAlreadyExistsException | AtomicMoveNotSupportedException e) {
            Files.deleteIfExists(tmp);
            Files.write(target, content);
        }
        return target;
    }

    private Path ensureCacheRoot() throws Exception {
        Path root = cacheRoot;
        if (root != null) {
            return root;
        }
        try {
            Files.createDirectories(configuredCacheRoot);
            root = configuredCacheRoot;
        } catch (Exception e) {
            // Native dev Macs have no /workspace — fall back to the JVM temp dir so local
            // runs still work; in the container the /workspace volume always exists.
            root = Path.of(System.getProperty("java.io.tmpdir"), "agenticos-scripts");
            Files.createDirectories(root);
            logger.warn("Script cache dir {} not writable ({}); using {}", configuredCacheRoot, e.getMessage(), root);
        }
        cacheRoot = root;
        return root;
    }

    // ---- process execution (mirrors BashCommandHandler semantics) ------------------------------

    private ObjectNode runProcess(ProcessBuilder pb, long timeoutMs, String commandDesc,
                                  byte[] stdin, CommandToken token) throws Exception {
        Process process = pb.start();

        // Always resolve stdin: write the payload if present, then CLOSE — an open stdin pipe
        // hangs interactive-capable tools forever (the `claude -p < /dev/null` lesson).
        try (OutputStream os = process.getOutputStream()) {
            if (stdin != null) {
                os.write(stdin);
            }
        } catch (Exception e) {
            logger.warn("Failed writing stdin to {}: {}", commandDesc, e.getMessage());
        }

        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();

        Thread stdoutThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    stdout.append(line).append("\n");
                }
            } catch (Exception e) {
                logger.warn("Error reading stdout: {}", e.getMessage());
            }
        });
        Thread stderrThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    stderr.append(line).append("\n");
                }
            } catch (Exception e) {
                logger.warn("Error reading stderr: {}", e.getMessage());
            }
        });
        stdoutThread.start();
        stderrThread.start();

        boolean completed = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
        if (!completed) {
            killProcessTree(process);
            process.waitFor(5, TimeUnit.SECONDS);
            stdoutThread.join(200);
            stderrThread.join(200);
            throw new RuntimeException("Script timed out after " + timeoutMs + "ms: " + commandDesc);
        }
        stdoutThread.join(1000);
        stderrThread.join(1000);

        int exitCode = process.exitValue();
        ObjectNode result = objectMapper.createObjectNode();
        result.put("exitCode", exitCode);
        result.put("stdout", stdout.toString().trim());
        result.put("stderr", stderr.toString().trim());
        result.put("success", exitCode == 0);
        result.put("command", commandDesc);

        maybeOffloadLargeStream(result, "stdout", token);
        maybeOffloadLargeStream(result, "stderr", token);

        if (exitCode != 0) {
            logger.warn("Script '{}' exited with code {}: {}", commandDesc, exitCode, stderr);
        }
        return result;
    }

    private void killProcessTree(Process process) {
        process.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
    }

    /** Same offload contract as BashCommandHandler: huge streams go to the blobstore, a preview
     *  plus {@code <field>Urn/Bytes/Truncated} stays inline; hard-truncate when upload fails. */
    private void maybeOffloadLargeStream(ObjectNode result, String field, CommandToken token) {
        if (stdoutMaxInlineBytes <= 0) {
            return;
        }
        JsonNode node = result.get(field);
        if (node == null || !node.isTextual()) {
            return;
        }
        String textValue = node.asText();
        if (textValue.isEmpty()) {
            return;
        }
        byte[] bytes = textValue.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= stdoutMaxInlineBytes) {
            return;
        }
        String preview = textValue.length() > stdoutPreviewChars ? textValue.substring(0, stdoutPreviewChars) : textValue;
        if (blobStoreClient == null) {
            result.put(field, preview);
            result.put(field + "Bytes", (long) bytes.length);
            result.put(field + "Truncated", true);
            return;
        }
        try {
            String host = token != null ? token.getBlobStoreHost() : null;
            String idStrategy = token != null ? token.getBlobStoreIdStrategy() : null;
            BlobUploadResult uploaded = blobStoreClient.upload(
                    host, bytes, "text/plain; charset=utf-8", idStrategy, field + ".txt");
            result.put(field, preview);
            result.put(field + "Urn", uploaded.urn());
            result.put(field + "Bytes", uploaded.size());
            result.put(field + "Truncated", true);
        } catch (Exception e) {
            logger.warn("Failed to offload large {} ({} bytes): {}", field, bytes.length, e.getMessage());
            result.put(field, preview);
            result.put(field + "Bytes", (long) bytes.length);
            result.put(field + "Truncated", true);
            result.put(field + "OffloadError", e.getMessage());
        }
    }

    // ---- helpers --------------------------------------------------------------------------------

    private JsonNode parseArgsIfStringified(JsonNode args) {
        if (args != null && args.isTextual()) {
            String textValue = args.asText();
            if (textValue != null && textValue.startsWith("{")) {
                try {
                    return objectMapper.readTree(textValue);
                } catch (Exception e) {
                    logger.warn("Failed to parse stringified args as JSON: {}", e.getMessage());
                }
            }
        }
        return args;
    }

    private static String text(JsonNode node, String field, String fallback) {
        JsonNode value = node == null ? null : node.get(field);
        return value != null && value.isTextual() && !value.asText().isBlank() ? value.asText() : fallback;
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
