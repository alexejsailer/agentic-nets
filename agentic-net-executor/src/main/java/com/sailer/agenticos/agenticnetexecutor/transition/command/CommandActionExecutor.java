package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * Executor for CommandAction transitions.
 *
 * Responsible for:
 * - Reading command tokens from input place
 * - Grouping commands by executor type
 * - Dispatching to CommandExecutorDispatcher
 * - Collecting and returning batch results
 */
@Service
public class CommandActionExecutor {

    private static final Logger logger = LoggerFactory.getLogger(CommandActionExecutor.class);

    private final CommandExecutorDispatcher dispatcher;
    private final ObjectMapper objectMapper;

    public CommandActionExecutor(CommandExecutorDispatcher dispatcher, ObjectMapper objectMapper) {
        this.dispatcher = dispatcher;
        this.objectMapper = objectMapper;
    }

    /**
     * Execute a command action with the given tokens.
     *
     * @param action The command action configuration
     * @param inputTokens The command tokens from the input place
     * @param transitionId The transition ID for logging/correlation
     * @return Result containing all batch results
     */
    public CommandActionResult execute(
            TransitionInscription.Action.CommandAction action,
            List<JsonNode> inputTokens,
            String transitionId
    ) {
        long startTime = System.currentTimeMillis();
        String batchPrefix = transitionId + "-" + System.currentTimeMillis();

        logger.info("Executing command action for transition {} with {} tokens", transitionId, inputTokens.size());

        try {
            // Parse command tokens
            List<CommandToken> commandTokens = new ArrayList<>();
            List<String> parseErrors = new ArrayList<>();

            for (JsonNode tokenJson : inputTokens) {
                try {
                    // Extract the data field if present (tokens from places have data wrapper)
                    JsonNode commandData = tokenJson.has("data") ? tokenJson.get("data") : tokenJson;

                    // Handle double-nesting: data.data may be a stringified JSON command token
                    // This happens when tokens are stored with {"data": "{...json string...}"}
                    commandData = unwrapDoubleNestedData(commandData);

                    // Reassemble flat args.X properties into nested args object if needed
                    commandData = reassembleFlatArgs(commandData);

                    // Parse stringified JSON fields (args, meta) that may have been stored as strings
                    commandData = parseStringifiedJsonFields(commandData);

                    // Ensure args.command is present for exec commands (normalize missing structure)
                    commandData = ensureArgsCommand(commandData);

                    CommandToken token = dispatcher.parseToken(commandData);

                    // Validate token
                    if (!token.isValid()) {
                        parseErrors.add("Invalid token: " + token.id());
                        continue;
                    }

                    // Check if executor is supported
                    if (!dispatcher.supportsExecutor(token.executor())) {
                        parseErrors.add("Unsupported executor '" + token.executor() + "' for token: " + token.id());
                        continue;
                    }

                    commandTokens.add(token);
                } catch (Exception e) {
                    parseErrors.add("Failed to parse token: " + e.getMessage());
                }
            }

            if (commandTokens.isEmpty()) {
                logger.warn("No valid command tokens found for transition {}", transitionId);
                return CommandActionResult.empty(batchPrefix, parseErrors);
            }

            // Group by executor and execute batches
            List<BatchResult> batchResults = dispatcher.executeBatch(commandTokens, batchPrefix);

            long durationMs = System.currentTimeMillis() - startTime;
            logger.info("Command action completed for transition {} in {}ms: {} batches, {} commands",
                    transitionId, durationMs, batchResults.size(), commandTokens.size());

            return CommandActionResult.fromBatchResults(batchPrefix, batchResults, parseErrors, durationMs);

        } catch (Exception e) {
            long durationMs = System.currentTimeMillis() - startTime;
            logger.error("Command action failed for transition {}: {}", transitionId, e.getMessage(), e);
            return CommandActionResult.failed(batchPrefix, e.getMessage(), durationMs);
        }
    }

    /**
     * Reassemble flat args.X properties into a nested args object.
     *
     * Agent transitions may create tokens with flat properties like:
     *   {"args.command": "...", "args.workingDir": "...", "args.timeoutMs": "180000"}
     *
     * This method transforms them into the expected nested structure:
     *   {"args": {"command": "...", "workingDir": "...", "timeoutMs": 180000}}
     *
     * @param tokenData The token JSON node
     * @return Token with reassembled args object, or original if no flat args found
     */
    private JsonNode reassembleFlatArgs(JsonNode tokenData) {
        if (tokenData == null || !tokenData.isObject()) {
            return tokenData;
        }

        // Check if there are flat args.X properties
        boolean hasFlatArgs = false;
        Iterator<String> fieldNames = tokenData.fieldNames();
        while (fieldNames.hasNext()) {
            if (fieldNames.next().startsWith("args.")) {
                hasFlatArgs = true;
                break;
            }
        }

        // If no flat args or already has nested args, return original
        if (!hasFlatArgs) {
            return tokenData;
        }

        logger.debug("Reassembling flat args.X properties into nested args object");

        // Create a mutable copy
        ObjectNode result = objectMapper.createObjectNode();
        ObjectNode argsNode = objectMapper.createObjectNode();

        // Preserve existing nested args fields first (flat args.X will override on conflict)
        JsonNode existingArgs = tokenData.get("args");
        if (existingArgs != null && existingArgs.isObject()) {
            existingArgs.fields().forEachRemaining(entry -> argsNode.set(entry.getKey(), entry.getValue()));
        }

        // Process all fields
        tokenData.fields().forEachRemaining(entry -> {
            String key = entry.getKey();
            JsonNode value = entry.getValue();

            if (key.startsWith("args.")) {
                // Extract the nested property name (e.g., "args.command" -> "command")
                String nestedKey = key.substring(5); // Remove "args." prefix

                // Try to convert numeric strings to numbers for timeoutMs
                if (nestedKey.equals("timeoutMs") && value.isTextual()) {
                    try {
                        long timeout = Long.parseLong(value.asText());
                        argsNode.put(nestedKey, timeout);
                    } catch (NumberFormatException e) {
                        argsNode.set(nestedKey, value);
                    }
                } else {
                    argsNode.set(nestedKey, value);
                }
            } else if (!key.equals("args")) {
                // Copy non-args fields as-is (skip existing "args" — already merged above)
                result.set(key, value);
            }
        });

        // Add the assembled args object
        if (!argsNode.isEmpty()) {
            result.set("args", argsNode);
        }

        logger.debug("Reassembled token: {}", result);
        return result;
    }

    /**
     * Ensure that args.command is present for bash/exec command tokens.
     *
     * LLM/agent transitions sometimes produce tokens where the args object exists
     * but is missing the required 'command' field. This can happen when:
     * - The shell command was placed only at top-level 'command' instead of in args
     * - The args object was created with other fields (workingDir, timeoutMs) but 'command' was omitted
     * - A MAP transition copied metadata but missed the actual command string
     *
     * This method detects tokens where:
     * 1. executor is "bash" and command is "exec"
     * 2. args exists but has no "command" field
     * 3. No args object exists at all
     *
     * For case (3), it creates a minimal args object. For case (2), it logs a warning
     * so the token fails validation with a clear error rather than a cryptic NPE.
     *
     * @param tokenData The token JSON node
     * @return Token with args.command ensured if fixable, or original
     */
    private JsonNode ensureArgsCommand(JsonNode tokenData) {
        if (tokenData == null || !tokenData.isObject()) {
            return tokenData;
        }

        String executor = tokenData.has("executor") ? tokenData.get("executor").asText() : null;
        String command = tokenData.has("command") ? tokenData.get("command").asText() : null;

        // Only applies to bash executor
        if (!"bash".equals(executor)) {
            return tokenData;
        }

        // Normalize: if 'command' is not a known command type ("exec", "script"),
        // assume the LLM placed the actual shell command in the top-level 'command' field.
        // Move it to args.command and set command to "exec".
        if (command != null && !command.isBlank()
                && !"exec".equals(command) && !"script".equals(command)) {
            logger.warn("Token {} has shell command in top-level 'command' field ('{}'), normalizing to exec with args.command",
                    tokenData.has("id") ? tokenData.get("id").asText() : "unknown", command);

            ObjectNode result = tokenData.deepCopy();
            result.put("command", "exec");

            JsonNode existingArgs = result.get("args");
            ObjectNode argsNode;
            if (existingArgs != null && existingArgs.isObject()) {
                argsNode = (ObjectNode) existingArgs;
            } else {
                argsNode = objectMapper.createObjectNode();
            }
            argsNode.put("command", command);
            result.set("args", argsNode);
            return result;
        }

        // From here, command is "exec" (or "script", which uses "script" field in args)
        if (!"exec".equals(command)) {
            return tokenData;
        }

        JsonNode args = tokenData.get("args");

        // Handle args as a plain string — treat it as the shell command itself
        if (args != null && args.isTextual()) {
            String argsText = args.asText();
            // Only treat as plain command if it doesn't look like JSON
            if (argsText != null && !argsText.isBlank() && !argsText.startsWith("{")) {
                logger.warn("Token {} has args as plain string, treating as shell command",
                        tokenData.has("id") ? tokenData.get("id").asText() : "unknown");

                ObjectNode result = tokenData.deepCopy();
                ObjectNode argsNode = objectMapper.createObjectNode();
                argsNode.put("command", argsText);
                result.set("args", argsNode);
                return result;
            }
        }

        // args exists and already has 'command' — nothing to do
        if (args != null && args.isObject() && args.has("command") && !args.get("command").isNull()
                && !args.get("command").asText().isBlank()) {
            return tokenData;
        }

        // Check if there's a 'shellCommand' or 'cmd' field at top level
        // that was meant to be args.command (common LLM format variation)
        String shellCommand = null;
        for (String altField : new String[]{"shellCommand", "cmd", "shell", "script"}) {
            if (tokenData.has(altField) && !tokenData.get(altField).isNull()) {
                shellCommand = tokenData.get(altField).asText();
                if (shellCommand != null && !shellCommand.isBlank()) {
                    break;
                }
                shellCommand = null;
            }
        }

        if (shellCommand != null) {
            logger.warn("Token {} has shell command in alternative field, moving to args.command",
                    tokenData.has("id") ? tokenData.get("id").asText() : "unknown");

            ObjectNode result = tokenData.deepCopy();
            ObjectNode argsNode;
            if (args != null && args.isObject()) {
                argsNode = (ObjectNode) args.deepCopy();
            } else {
                argsNode = objectMapper.createObjectNode();
            }
            argsNode.put("command", shellCommand);
            result.set("args", argsNode);
            // Remove the alternative field to avoid confusion
            for (String altField : new String[]{"shellCommand", "cmd", "shell", "script"}) {
                result.remove(altField);
            }
            return result;
        }

        // If args exists but without command, log clearly for debugging
        if (args != null && args.isObject() && (!args.has("command") || args.get("command").isNull()
                || args.get("command").asText().isBlank())) {
            logger.error("Token {} has args object but 'command' field is missing. Args: {}",
                    tokenData.has("id") ? tokenData.get("id").asText() : "unknown", args);
        }

        return tokenData;
    }

    /**
     * Parse stringified JSON fields in token data.
     *
     * When tokens are stored in agentic-net-node, nested JSON objects like 'args' and 'meta'
     * may be serialized as strings. This method detects and parses these fields back
     * to proper JSON objects for CommandToken deserialization.
     *
     * Example transformation:
     *   {"args": "{\"command\":\"echo hello\",\"timeoutMs\":60000}"}
     *   becomes
     *   {"args": {"command": "echo hello", "timeoutMs": 60000}}
     *
     * @param tokenData The token JSON node
     * @return Token with parsed JSON fields, or original if no stringified fields found
     */
    private JsonNode parseStringifiedJsonFields(JsonNode tokenData) {
        if (tokenData == null || !tokenData.isObject()) {
            return tokenData;
        }

        // Fields that may contain stringified JSON
        String[] jsonFields = {"args", "meta", "blobStore"};
        boolean hasStringifiedFields = false;

        for (String field : jsonFields) {
            if (tokenData.has(field) && tokenData.get(field).isTextual()) {
                String value = tokenData.get(field).asText();
                if (value.startsWith("{") || value.startsWith("[")) {
                    hasStringifiedFields = true;
                    break;
                }
            }
        }

        if (!hasStringifiedFields) {
            return tokenData;
        }

        logger.debug("Parsing stringified JSON fields in token");

        // Create a mutable copy
        ObjectNode result = objectMapper.createObjectNode();

        // Copy all fields, parsing stringified JSON where found
        tokenData.fields().forEachRemaining(entry -> {
            String key = entry.getKey();
            JsonNode value = entry.getValue();

            if (value.isTextual()) {
                String text = value.asText();
                // Check if it looks like JSON
                if ((text.startsWith("{") && text.endsWith("}")) ||
                    (text.startsWith("[") && text.endsWith("]"))) {
                    try {
                        JsonNode parsed = objectMapper.readTree(text);
                        result.set(key, parsed);
                        logger.debug("Parsed stringified {} field from string to JSON", key);
                    } catch (Exception e) {
                        // Not valid JSON, keep as string
                        result.set(key, value);
                    }
                } else {
                    result.set(key, value);
                }
            } else {
                result.set(key, value);
            }
        });

        return result;
    }

    /**
     * Unwrap double-nested or stringified data structure.
     *
     * When tokens are created via MAP transitions and stored in places, they may have
     * several nested/stringified patterns:
     *
     * Pattern A - Entire token is a stringified JSON string:
     *   tokenData = "{\"kind\":\"command\",...}"  (TextNode)
     *
     * Pattern B - Double-nested with stringified inner data:
     *   tokenData = {
     *     data: "{\"kind\":\"command\",...}"  // stringified JSON
     *   }
     *
     * This method detects and unwraps these structures by:
     * 1. If input is a TextNode (stringified JSON), parse it directly
     * 2. If input has a "data" field that is a string, parse that
     * 3. Return the parsed object as the command data
     *
     * @param tokenData The token JSON node (may be double-nested or stringified)
     * @return Unwrapped command data, or original if not nested/stringified
     */
    private JsonNode unwrapDoubleNestedData(JsonNode tokenData) {
        if (tokenData == null) {
            return tokenData;
        }

        // Pattern A: The input itself is a TextNode containing stringified JSON
        if (tokenData.isTextual()) {
            String jsonStr = tokenData.asText();
            if ((jsonStr.startsWith("{") && jsonStr.endsWith("}")) ||
                (jsonStr.startsWith("[") && jsonStr.endsWith("]"))) {
                try {
                    JsonNode parsed = objectMapper.readTree(jsonStr);
                    logger.debug("Unwrapped stringified token JSON to object");
                    return parsed;
                } catch (Exception e) {
                    logger.warn("Failed to parse stringified token as JSON: {}", e.getMessage());
                    return tokenData;
                }
            }
            return tokenData;
        }

        // Pattern B: Object with a "data" field that is a string
        if (tokenData.isObject() && tokenData.has("data") && tokenData.get("data").isTextual()) {
            String innerDataStr = tokenData.get("data").asText();

            // Check if it looks like JSON
            if ((innerDataStr.startsWith("{") && innerDataStr.endsWith("}")) ||
                (innerDataStr.startsWith("[") && innerDataStr.endsWith("]"))) {
                try {
                    JsonNode parsed = objectMapper.readTree(innerDataStr);
                    logger.debug("Unwrapped double-nested data.data string to JSON object");
                    return parsed;
                } catch (Exception e) {
                    logger.warn("Failed to parse data.data string as JSON: {}", e.getMessage());
                    // Fall through to Pattern C
                }
            }
        }

        // Pattern C: Object with a "value" field that is a string containing JSON
        // This is the standard leaf property format in agentic-net-node where leaves store
        // their content as properties: {value: "{...json string...}"}
        if (tokenData.isObject() && tokenData.has("value") && tokenData.get("value").isTextual()) {
            String valueStr = tokenData.get("value").asText();
            if ((valueStr.startsWith("{") && valueStr.endsWith("}")) ||
                (valueStr.startsWith("[") && valueStr.endsWith("]"))) {
                try {
                    JsonNode parsed = objectMapper.readTree(valueStr);
                    logger.debug("Unwrapped leaf value property to JSON object");
                    return parsed;
                } catch (Exception e) {
                    logger.warn("Failed to parse value property as JSON: {}", e.getMessage());
                }
            }
        }

        return tokenData;
    }

    /**
     * Execute a single command (for testing/direct invocation).
     */
    public CommandResult executeSingle(CommandToken token) {
        return dispatcher.executeCommand(token);
    }

    /**
     * Result container for command action execution.
     */
    public record CommandActionResult(
            String batchPrefix,
            List<BatchResult> batchResults,
            List<String> parseErrors,
            int totalCommands,
            int successCount,
            int failedCount,
            long durationMs,
            boolean success
    ) {

        public static CommandActionResult fromBatchResults(
                String batchPrefix,
                List<BatchResult> batchResults,
                List<String> parseErrors,
                long durationMs
        ) {
            int total = 0;
            int success = 0;
            int failed = 0;

            for (BatchResult batch : batchResults) {
                total += batch.totalCount();
                success += batch.successCount();
                failed += batch.failedCount();
            }

            // Include parse errors in failure count
            failed += parseErrors.size();

            return new CommandActionResult(
                    batchPrefix,
                    batchResults,
                    parseErrors,
                    total,
                    success,
                    failed,
                    durationMs,
                    failed == 0
            );
        }

        public static CommandActionResult empty(String batchPrefix, List<String> errors) {
            return new CommandActionResult(
                    batchPrefix,
                    List.of(),
                    errors,
                    0, 0, errors.size(),
                    0L,
                    errors.isEmpty()
            );
        }

        public static CommandActionResult failed(String batchPrefix, String error, long durationMs) {
            return new CommandActionResult(
                    batchPrefix,
                    List.of(),
                    List.of(error),
                    0, 0, 1,
                    durationMs,
                    false
            );
        }

        /**
         * Convert to JSON for emission to output place.
         * Extracts key fields from stdout JSON (like confidence) and promotes them to top level.
         */
        public JsonNode toJson(ObjectMapper mapper) {
            ObjectNode result = mapper.createObjectNode();
            result.put("batchPrefix", batchPrefix);
            result.put("totalCommands", totalCommands);
            result.put("successCount", successCount);
            result.put("failedCount", failedCount);
            result.put("durationMs", durationMs);
            result.put("success", success);

            // Extract and promote key fields from first successful result's stdout
            extractAndPromoteStdoutFields(result, mapper);

            // Add batch results
            ArrayNode batches = mapper.createArrayNode();
            for (BatchResult batch : batchResults) {
                ObjectNode batchNode = mapper.createObjectNode();
                batchNode.put("executor", batch.executor());
                batchNode.put("batchId", batch.batchId());
                batchNode.put("totalCount", batch.totalCount());
                batchNode.put("successCount", batch.successCount());
                batchNode.put("failedCount", batch.failedCount());

                // Add individual results
                ArrayNode results = mapper.createArrayNode();
                for (CommandResult cr : batch.results()) {
                    ObjectNode crNode = mapper.createObjectNode();
                    crNode.put("id", cr.id());
                    crNode.put("status", cr.status().name());
                    if (cr.output() != null) {
                        crNode.set("output", cr.output());
                    }
                    if (cr.error() != null) {
                        crNode.put("error", cr.error());
                    }
                    crNode.put("durationMs", cr.durationMs() != null ? cr.durationMs() : 0);
                    results.add(crNode);
                }
                batchNode.set("results", results);
                batches.add(batchNode);
            }
            result.set("batchResults", batches);

            // Add parse errors
            if (!parseErrors.isEmpty()) {
                ArrayNode errors = mapper.createArrayNode();
                parseErrors.forEach(errors::add);
                result.set("parseErrors", errors);
            }

            return result;
        }

        /**
         * Extract JSON from stdout and promote key fields to top level.
         * Looks for JSON in markdown code blocks or raw JSON in stdout.
         * Promotes: confidence, source, extractionNotes, errorCodes, specs, generatorModels
         */
        private void extractAndPromoteStdoutFields(ObjectNode result, ObjectMapper mapper) {
            List<CommandResult> successfulResults = getAllSuccessfulResults();
            if (successfulResults.isEmpty()) {
                return;
            }

            CommandResult firstSuccess = successfulResults.get(0);
            if (firstSuccess.output() == null) {
                return;
            }

            JsonNode output = firstSuccess.output();
            if (!output.has("stdout")) {
                return;
            }

            String stdout = output.get("stdout").asText();
            if (stdout == null || stdout.isBlank()) {
                return;
            }

            // Try to extract JSON from stdout
            JsonNode extractedJson = extractJsonFromStdout(stdout, mapper);
            if (extractedJson == null || !extractedJson.isObject()) {
                return;
            }

            // Promote key fields to top level
            String[] fieldsToPromote = {"confidence", "source", "extractionNotes", "errorCodes",
                                         "specs", "generatorModels", "redirectedTo", "troubleshooting",
                                         "supportResources"};

            for (String field : fieldsToPromote) {
                if (extractedJson.has(field)) {
                    result.set(field, extractedJson.get(field));
                }
            }

            // Also store the full parsed JSON for reference
            result.set("parsedStdout", extractedJson);
        }

        /**
         * Extract JSON from stdout text.
         * Handles:
         * - JSON in markdown code blocks (```json ... ```)
         * - Raw JSON starting with {
         */
        private JsonNode extractJsonFromStdout(String stdout, ObjectMapper mapper) {
            // Try to find JSON in markdown code block
            int jsonBlockStart = stdout.indexOf("```json");
            if (jsonBlockStart >= 0) {
                int jsonStart = stdout.indexOf("\n", jsonBlockStart) + 1;
                int jsonEnd = stdout.indexOf("```", jsonStart);
                if (jsonStart > 0 && jsonEnd > jsonStart) {
                    String jsonStr = stdout.substring(jsonStart, jsonEnd).trim();
                    try {
                        return mapper.readTree(jsonStr);
                    } catch (Exception e) {
                        // Fall through to try other methods
                    }
                }
            }

            // Try to find JSON starting with { (might be indented)
            int braceStart = stdout.indexOf("{");
            if (braceStart >= 0) {
                // Find the matching closing brace
                int depth = 0;
                int braceEnd = -1;
                boolean inString = false;
                char prevChar = 0;

                for (int i = braceStart; i < stdout.length(); i++) {
                    char c = stdout.charAt(i);

                    if (c == '"' && prevChar != '\\') {
                        inString = !inString;
                    } else if (!inString) {
                        if (c == '{') depth++;
                        else if (c == '}') {
                            depth--;
                            if (depth == 0) {
                                braceEnd = i + 1;
                                break;
                            }
                        }
                    }
                    prevChar = c;
                }

                if (braceEnd > braceStart) {
                    String jsonStr = stdout.substring(braceStart, braceEnd);
                    try {
                        return mapper.readTree(jsonStr);
                    } catch (Exception e) {
                        // JSON parsing failed
                    }
                }
            }

            return null;
        }

        /**
         * Get all successful command results.
         */
        public List<CommandResult> getAllSuccessfulResults() {
            return batchResults.stream()
                    .flatMap(b -> b.getSuccessfulResults().stream())
                    .toList();
        }

        /**
         * Get all failed command results.
         */
        public List<CommandResult> getAllFailedResults() {
            return batchResults.stream()
                    .flatMap(b -> b.getFailedResults().stream())
                    .toList();
        }
    }
}
