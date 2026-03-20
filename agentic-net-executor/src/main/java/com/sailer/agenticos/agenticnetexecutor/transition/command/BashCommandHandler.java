package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetexecutor.blob.BlobStoreClient;
import com.sailer.agenticos.agenticnetexecutor.blob.BlobStoreException;
import com.sailer.agenticos.agenticnetexecutor.blob.BlobUploadResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Command handler for bash/shell operations.
 *
 * Supported commands:
 * - exec: Execute a single command
 * - script: Execute a multi-line script
 *
 * Security considerations:
 * - Commands are executed with the permissions of the executor process
 * - Working directory can be specified
 * - Environment variables can be passed
 * - Timeout enforced to prevent hanging processes
 */
@Component
public class BashCommandHandler implements CommandHandler {

    private static final Logger logger = LoggerFactory.getLogger(BashCommandHandler.class);
    private static final String EXECUTOR_TYPE = "bash";

    private static final Set<String> SUPPORTED_COMMANDS = Set.of("exec", "script");

    private static final long DEFAULT_TIMEOUT_MS = 60000; // 60 seconds
    private static final long DEFAULT_MAX_TIMEOUT_MS = 600000; // 10 minutes

    private final ObjectMapper objectMapper;
    private final BlobStoreClient blobStoreClient;
    private final long maxTimeoutMs;

    public BashCommandHandler(ObjectMapper objectMapper, BlobStoreClient blobStoreClient,
                              @org.springframework.beans.factory.annotation.Value("${executor.command.max-timeout-ms:600000}") long maxTimeoutMs) {
        this.objectMapper = objectMapper;
        this.blobStoreClient = blobStoreClient;
        this.maxTimeoutMs = maxTimeoutMs > 0 ? maxTimeoutMs : DEFAULT_MAX_TIMEOUT_MS;
        if (this.maxTimeoutMs != DEFAULT_MAX_TIMEOUT_MS) {
            logger.info("Command max timeout configured: {}ms ({}h {}m)", this.maxTimeoutMs,
                    this.maxTimeoutMs / 3600000, (this.maxTimeoutMs % 3600000) / 60000);
        }
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
    public CommandResult execute(CommandToken token) {
        long startTime = System.currentTimeMillis();

        try {
            // Parse args if it's a stringified JSON (happens when stored in tree properties)
            JsonNode args = parseArgsIfStringified(token.args());

            JsonNode output = switch (token.command()) {
                case "exec" -> executeExec(args, token);
                case "script" -> executeScript(args, token);
                default -> throw new IllegalArgumentException("Unknown command: " + token.command());
            };

            long durationMs = System.currentTimeMillis() - startTime;
            logger.debug("Command {}:{} completed in {}ms", token.executor(), token.command(), durationMs);

            // Check exit code to determine success/failure
            boolean commandSuccess = !output.has("success") || output.get("success").asBoolean(true);
            if (commandSuccess) {
                return CommandResult.success(token.id(), output, durationMs, token.getMetaAsMap());
            } else {
                int exitCode = output.has("exitCode") ? output.get("exitCode").asInt() : -1;
                return new CommandResult(token.id(), CommandResult.Status.FAILED, output,
                        "Command exited with code " + exitCode, durationMs,
                        java.time.Instant.now(), token.getMetaAsMap());
            }

        } catch (Exception e) {
            long durationMs = System.currentTimeMillis() - startTime;
            logger.error("Command {}:{} failed: {}", token.executor(), token.command(), e.getMessage());
            return CommandResult.failed(token.id(), e.getMessage(), durationMs, token.getMetaAsMap());
        }
    }

    /**
     * Parse args if it's a stringified JSON string.
     * This handles tokens stored in tree properties where JSON objects become strings.
     */
    private JsonNode parseArgsIfStringified(JsonNode args) {
        if (args == null) {
            return null;
        }
        // If args is a text node (string), try to parse it as JSON
        if (args.isTextual()) {
            String argsText = args.asText();
            if (argsText != null && !argsText.isBlank() && argsText.startsWith("{")) {
                try {
                    return objectMapper.readTree(argsText);
                } catch (Exception e) {
                    logger.warn("Failed to parse stringified args as JSON: {}", e.getMessage());
                    return args;
                }
            }
        }
        return args;
    }

    private JsonNode executeExec(JsonNode args, CommandToken token) throws Exception {
        String command = getRequiredString(args, "command");
        String workingDir = getString(args, "workingDir", null);
        long timeoutMs = getLong(args, "timeoutMs", DEFAULT_TIMEOUT_MS);
        Map<String, String> env = getEnvironment(args);
        boolean captureStderr = getBoolean(args, "captureStderr", true);

        // Validate timeout
        timeoutMs = Math.min(timeoutMs, maxTimeoutMs);

        ProcessBuilder pb = new ProcessBuilder("bash", "-c", command);

        if (workingDir != null) {
            pb.directory(new File(workingDir));
        }

        if (env != null && !env.isEmpty()) {
            pb.environment().putAll(env);
        }

        if (captureStderr) {
            pb.redirectErrorStream(true);
        }

        JsonNode processResult = runProcess(pb, timeoutMs, command);

        // Handle binary URN result if configured
        if (token.isBinaryUrn()) {
            return handleBinaryUrnResult(processResult, args, token);
        }

        return processResult;
    }

    private JsonNode executeScript(JsonNode args, CommandToken token) throws Exception {
        String script = getRequiredString(args, "script");
        String workingDir = getString(args, "workingDir", null);
        long timeoutMs = getLong(args, "timeoutMs", DEFAULT_TIMEOUT_MS);
        Map<String, String> env = getEnvironment(args);
        boolean captureStderr = getBoolean(args, "captureStderr", true);

        // Validate timeout
        timeoutMs = Math.min(timeoutMs, maxTimeoutMs);

        // Write script to temporary file
        Path tempScript = Files.createTempFile("agenticos-script-", ".sh");
        try {
            Files.writeString(tempScript, script, StandardCharsets.UTF_8);
            tempScript.toFile().setExecutable(true);

            ProcessBuilder pb = new ProcessBuilder("bash", tempScript.toString());

            if (workingDir != null) {
                pb.directory(new File(workingDir));
            }

            if (env != null && !env.isEmpty()) {
                pb.environment().putAll(env);
            }

            if (captureStderr) {
                pb.redirectErrorStream(true);
            }

            JsonNode processResult = runProcess(pb, timeoutMs, "script");

            // Handle binary URN result if configured
            if (token.isBinaryUrn()) {
                return handleBinaryUrnResult(processResult, args, token);
            }

            return processResult;
        } finally {
            Files.deleteIfExists(tempScript);
        }
    }

    private JsonNode runProcess(ProcessBuilder pb, long timeoutMs, String commandDesc) throws Exception {
        Process process = pb.start();

        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();

        // Read stdout
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

        // Read stderr (if not merged)
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
            throw new RuntimeException("Command timed out after " + timeoutMs + "ms: " + commandDesc);
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

        if (exitCode != 0) {
            logger.warn("Command '{}' exited with code {}: {}", commandDesc, exitCode, stderr);
        }

        return result;
    }

    /**
     * Handle binary URN result by uploading output file to BlobStore.
     *
     * @param processResult The result from running the process
     * @param args Command arguments (contains outputFile path)
     * @param token The command token (contains blobStore configuration)
     * @return Modified result with binaryUrn instead of inline content
     */
    private JsonNode handleBinaryUrnResult(JsonNode processResult, JsonNode args, CommandToken token)
            throws Exception {
        // Get the output file path
        String outputFile = token.getOutputFile();
        if (outputFile == null) {
            outputFile = getString(args, "outputFile", null);
        }

        if (outputFile == null || outputFile.isBlank()) {
            logger.warn("binaryUrn requested but no outputFile specified, returning inline result");
            return processResult;
        }

        // Check if the process succeeded
        boolean success = processResult.has("success") && processResult.get("success").asBoolean(false);
        if (!success) {
            logger.warn("Process failed, skipping binary upload");
            return processResult;
        }

        // Verify the output file exists
        Path outputPath = Path.of(outputFile);
        if (!Files.exists(outputPath)) {
            logger.warn("Output file does not exist: {}, returning inline result", outputFile);
            return processResult;
        }

        // Upload to BlobStore
        try {
            String host = token.getBlobStoreHost();
            String idStrategy = token.getBlobStoreIdStrategy();

            logger.info("Uploading binary output {} to BlobStore (strategy: {})", outputFile, idStrategy);

            BlobUploadResult uploadResult = blobStoreClient.uploadFile(host, outputPath, idStrategy);

            // Build result with binary URN
            ObjectNode result = objectMapper.createObjectNode();
            result.put("exitCode", processResult.get("exitCode").asInt());
            result.put("binaryUrn", uploadResult.urn());
            result.put("binarySize", uploadResult.size());
            result.put("contentType", uploadResult.contentType());
            result.put("success", true);
            result.put("command", processResult.has("command") ? processResult.get("command").asText() : "");

            // Include additional info if available
            if (uploadResult.downloadUrl() != null) {
                result.put("downloadUrl", uploadResult.downloadUrl());
            }
            if (uploadResult.sha256() != null) {
                result.put("sha256", uploadResult.sha256());
            }

            logger.info("Binary output uploaded successfully: {}", uploadResult.urn());

            return result;

        } catch (BlobStoreException e) {
            logger.error("Failed to upload binary to BlobStore: {}", e.getMessage());
            // Return original result with error info
            ObjectNode result = (ObjectNode) processResult;
            result.put("binaryUploadError", e.getMessage());
            return result;
        }
    }

    /**
     * Kill the process and its entire process tree.
     * On Linux, sends SIGKILL to the process group to clean up grandchild processes.
     * Falls back to destroyForcibly() on other platforms or if group kill fails.
     */
    private void killProcessTree(Process process) {
        long pid = process.pid();
        try {
            String os = System.getProperty("os.name", "").toLowerCase();
            if (os.contains("linux") || os.contains("mac") || os.contains("darwin")) {
                // Kill the entire process group: negative PID targets the group
                ProcessBuilder killPb = new ProcessBuilder("kill", "-9", "--", "-" + pid);
                Process killProcess = killPb.start();
                boolean killDone = killProcess.waitFor(5, TimeUnit.SECONDS);
                if (!killDone || killProcess.exitValue() != 0) {
                    // Fallback: kill by PID tree using pkill
                    new ProcessBuilder("pkill", "-9", "-P", String.valueOf(pid)).start().waitFor(5, TimeUnit.SECONDS);
                    process.destroyForcibly();
                }
            } else {
                process.destroyForcibly();
            }
        } catch (Exception e) {
            logger.warn("Process tree kill failed for PID {}, falling back to destroyForcibly: {}", pid, e.getMessage());
            process.destroyForcibly();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, String> getEnvironment(JsonNode args) {
        if (args == null || !args.has("env") || args.get("env").isNull()) {
            return null;
        }

        try {
            return objectMapper.convertValue(args.get("env"), Map.class);
        } catch (Exception e) {
            logger.warn("Failed to parse environment variables: {}", e.getMessage());
            return null;
        }
    }

    // Helper methods for extracting arguments

    private String getRequiredString(JsonNode args, String field) {
        if (args == null || !args.has(field) || args.get(field).isNull()) {
            throw new IllegalArgumentException("Required field '" + field + "' is missing");
        }
        return args.get(field).asText();
    }

    private String getString(JsonNode args, String field, String defaultValue) {
        if (args == null || !args.has(field) || args.get(field).isNull()) {
            return defaultValue;
        }
        return args.get(field).asText(defaultValue);
    }

    private boolean getBoolean(JsonNode args, String field, boolean defaultValue) {
        if (args == null || !args.has(field) || args.get(field).isNull()) {
            return defaultValue;
        }
        return args.get(field).asBoolean(defaultValue);
    }

    private long getLong(JsonNode args, String field, long defaultValue) {
        if (args == null || !args.has(field) || args.get(field).isNull()) {
            return defaultValue;
        }
        return args.get(field).asLong(defaultValue);
    }

    @Override
    public boolean supportsConcurrentExecution() {
        return false; // Bash commands should be serialized for safety
    }
}
