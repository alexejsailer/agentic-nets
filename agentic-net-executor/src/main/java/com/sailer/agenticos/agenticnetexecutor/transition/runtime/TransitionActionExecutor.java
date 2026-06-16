package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.command.CommandActionExecutor;
import com.sailer.agenticos.agenticnetexecutor.transition.dto.ArcQueryResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Map;
import java.util.Objects;

public class TransitionActionExecutor {

    private static final Logger logger = LoggerFactory.getLogger(TransitionActionExecutor.class);

    private final ObjectMapper objectMapper;
    private final CommandActionExecutor commandActionExecutor;

    public TransitionActionExecutor(ObjectMapper objectMapper,
                                    CommandActionExecutor commandActionExecutor) {
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper");
        this.commandActionExecutor = Objects.requireNonNull(commandActionExecutor, "commandActionExecutor");
    }

    public ActionResult execute(TransitionDefinition definition,
                                Map<String, ArcQueryResult.TokenBinding> bindings,
                                TransitionContext context) {
        TransitionInscription.Action action = definition.inscription().action();
        if (!"command".equals(action.type())) {
            logger.error("Unsupported action type '{}' for transition {}. Non-command actions run on master.",
                    action.type(), definition.transitionId());
            return ActionResult.failure(Map.of(),
                    Map.of("error", "Non-command actions must execute on master"));
        }

        TransitionInscription.Action.CommandAction commandAction =
                (TransitionInscription.Action.CommandAction) action;

        // Collect input tokens: only from the inputPlace binding if specified,
        // otherwise fall back to all bindings (backward compatible)
        String inputPlaceKey = commandAction.inputPlace();
        List<JsonNode> inputTokens;
        if (inputPlaceKey != null && bindings.containsKey(inputPlaceKey)) {
            inputTokens = List.of(bindings.get(inputPlaceKey).data());
        } else {
            inputTokens = bindings.values().stream()
                    .map(ArcQueryResult.TokenBinding::data)
                    .toList();
        }

        // Inject resolved credentials (fetched from vault by master and passed in the context) as
        // environment variables for the command, so a command transition can authenticate to an
        // external API WITHOUT the secret appearing in the command string/argv, the inscription, or
        // any token. The command references them as ordinary env vars (e.g. $apiKey).
        Object credsAttr = context != null ? context.attribute("credentials") : null;
        if (credsAttr instanceof Map<?, ?> credsMap && !credsMap.isEmpty()) {
            inputTokens = inputTokens.stream()
                    .map(token -> injectCredentialEnv(token, credsMap))
                    .toList();
        }

        CommandActionExecutor.CommandActionResult result = commandActionExecutor.execute(
                commandAction, inputTokens, definition.transitionId());

        // Convert to JSON once for both payloads and metadata (includes promoted stdout fields)
        JsonNode resultJson = result.toJson(objectMapper);

        if (result.success()) {
            Map<String, List<EmissionPayload>> payloads = buildPayloads(definition, resultJson, bindings, "success");
            return ActionResult.success(payloads, Map.of("commandResult", resultJson));
        }

        Map<String, List<EmissionPayload>> payloads = buildPayloads(definition, resultJson, bindings, "error");
        logger.info("🔍 ERROR PATH: buildPayloads returned {} postsets, keys={}", payloads.size(), payloads.keySet());
        return ActionResult.failure(payloads, Map.of("commandResult", resultJson));
    }

    /**
     * Merge resolved credentials into a command token's args.env so they reach the child process as
     * environment variables (never as argv/command-string text or a persisted token field). Returns
     * a copy of the token with env merged.
     */
    private JsonNode injectCredentialEnv(JsonNode token, Map<?, ?> creds) {
        if (token == null || !token.isObject()) {
            return token;
        }
        ObjectNode copy = (ObjectNode) token.deepCopy();
        JsonNode argsNode = copy.get("args");
        ObjectNode args = (argsNode != null && argsNode.isObject())
                ? (ObjectNode) argsNode : objectMapper.createObjectNode();
        JsonNode envNode = args.get("env");
        ObjectNode env = (envNode != null && envNode.isObject())
                ? (ObjectNode) envNode : objectMapper.createObjectNode();
        for (Map.Entry<?, ?> e : creds.entrySet()) {
            if (e.getKey() != null && e.getValue() != null) {
                env.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
            }
        }
        args.set("env", env);
        copy.set("args", args);
        return copy;
    }

    private Map<String, List<EmissionPayload>> buildPayloads(TransitionDefinition definition,
                                                             JsonNode resultJson,
                                                             Map<String, ArcQueryResult.TokenBinding> bindings,
                                                             String phase) {
        Map<String, List<EmissionPayload>> payloads = new java.util.HashMap<>();

        for (TransitionInscription.Emit emit : definition.inscription().emit()) {
            if (!emit.appliesOn(phase)) {
                continue;
            }

            JsonNode data = resolveFromExpression(emit.from(), resultJson, bindings);
            payloads.computeIfAbsent(emit.to(), k -> new java.util.ArrayList<>())
                    .add(new EmissionPayload(null, data));
        }
        return payloads;
    }

    /**
     * Resolve the "from" expression in an emit rule.
     *
     * Supported expressions:
     * - "@result" or null → the command action result JSON
     * - "@input.data" → the original input token's data field (the leaf value)
     * - "@input._meta" → the original input token's metadata
     */
    private JsonNode resolveFromExpression(String from,
                                           JsonNode resultJson,
                                           Map<String, ArcQueryResult.TokenBinding> bindings) {
        if (from == null || from.isBlank() || "@result".equals(from)) {
            return resultJson;
        }

        // Handle @input.data - resolve original input token data
        if (from.startsWith("@input")) {
            // Find the input preset binding (typically named "input")
            ArcQueryResult.TokenBinding inputBinding = bindings.get("input");
            if (inputBinding == null && !bindings.isEmpty()) {
                // Fall back to first binding if "input" preset not found
                inputBinding = bindings.values().iterator().next();
            }

            if (inputBinding == null) {
                logger.warn("No input binding found for from expression '{}', falling back to result", from);
                return resultJson;
            }

            if ("@input.data".equals(from)) {
                // Return the data field which contains the leaf value
                return inputBinding.data();
            } else if ("@input._meta".equals(from)) {
                // Build _meta from binding fields
                var metaNode = objectMapper.createObjectNode();
                metaNode.put("id", inputBinding.id());
                metaNode.put("name", inputBinding.name());
                metaNode.put("parentId", inputBinding.parentId());
                metaNode.put("type", inputBinding.type());
                return metaNode;
            }

            // Unknown @input subpath, return data as default
            logger.debug("Unknown @input subpath in '{}', using data field", from);
            return inputBinding.data();
        }

        logger.debug("Unknown from expression '{}', using result", from);
        return resultJson;
    }
}
