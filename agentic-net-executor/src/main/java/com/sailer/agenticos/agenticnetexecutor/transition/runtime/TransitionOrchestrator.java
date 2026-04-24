package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStatus;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStore;
import com.sailer.agenticos.agenticnetexecutor.transition.dto.ArcQueryResult;
import com.sailer.agenticos.agenticnetexecutor.transition.service.ConsumptionService;
import com.sailer.agenticos.agenticnetexecutor.transition.service.EmissionService;
import com.sailer.agenticos.agenticnetexecutor.util.HostUtil;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@Component
public class TransitionOrchestrator {

    private static final Logger logger = LoggerFactory.getLogger(TransitionOrchestrator.class);

    private final TransitionStore transitionStore;
    private final EmissionService emissionService;
    private final ConsumptionService consumptionService;
    private final TransitionActionExecutor actionExecutor;
    private final MeterRegistry meterRegistry;
    private final ExecutorService executor;
    private final Set<String> inFlight = ConcurrentHashMap.newKeySet();

    public TransitionOrchestrator(TransitionStore transitionStore,
                                  EmissionService emissionService,
                                  ConsumptionService consumptionService,
                                  TransitionActionExecutor actionExecutor,
                                  MeterRegistry meterRegistry) {
        this.transitionStore = Objects.requireNonNull(transitionStore, "transitionStore");
        this.emissionService = Objects.requireNonNull(emissionService, "emissionService");
        this.consumptionService = Objects.requireNonNull(consumptionService, "consumptionService");
        this.actionExecutor = Objects.requireNonNull(actionExecutor, "actionExecutor");
        this.meterRegistry = Objects.requireNonNull(meterRegistry, "meterRegistry");
        this.executor = Executors.newVirtualThreadPerTaskExecutor();
    }

    /**
     * Execute transition using bound tokens from master (FIRE command)
     * This is the new architecture where master binds tokens and executor uses them
     * @param transitionId Transition to execute
     * @param boundTokens Tokens bound by master for each preset
     */
    public void executeWithBoundTokens(String modelId, String transitionId, Map<String, List<Map<String, Object>>> boundTokens) {
        var maybeDefinition = transitionStore.get(modelId, transitionId);
        if (maybeDefinition.isEmpty()) {
            logger.warn("Cannot execute unknown transition: {}:{}", modelId, transitionId);
            return;
        }
        TransitionDefinition definition = maybeDefinition.get();
        if (!isCommandTransition(definition)) {
            logger.warn("Skipping execution for non-command transition {}:{}. Executor only runs command actions.", modelId, transitionId);
            return;
        }
        // Pre-submit stop guard: if STOP arrived (locally marked the transition STOPPED)
        // before or alongside this FIRE, don't start the work.
        if (!isRunnable(definition.status())) {
            logger.info("⏹️ Skipping FIRE for transition {}:{} — local status is {} (stop requested before submit)",
                    modelId, transitionId, definition.status());
            return;
        }
        String flightKey = modelId + ":" + transitionId;
        if (!inFlight.add(flightKey)) {
            logger.debug("Transition {}:{} already in flight, skipping bound token execution", modelId, transitionId);
            return;
        }
        executor.submit(() -> {
            try {
                // Post-submit stop guard: re-check inside the virtual thread in case STOP
                // landed between submit() and thread start, or while queued.
                var latest = transitionStore.get(modelId, transitionId);
                if (latest.isEmpty()) {
                    logger.info("⏹️ Skipping FIRE for transition {}:{} — definition was removed after submit",
                            modelId, transitionId);
                    return;
                }
                TransitionStatus latestStatus = latest.get().status();
                if (!isRunnable(latestStatus)) {
                    logger.info("⏹️ Skipping FIRE for transition {}:{} inside worker — local status is {} (stop requested after submit)",
                            modelId, transitionId, latestStatus);
                    return;
                }
                runSingleWithBoundTokens(latest.get(), boundTokens);
            } finally {
                inFlight.remove(flightKey);
            }
        });
    }

    /**
     * Whether the local status permits executing a FIRE. Matches the master-side
     * gate in ExecutorPollingController (running/starting allowed).
     */
    private static boolean isRunnable(TransitionStatus status) {
        return status == TransitionStatus.RUNNING || status == TransitionStatus.STARTING;
    }

    /**
     * Execute once synchronously and return the action result.
     * Used by the fireOnce endpoint while reusing the same code path as FIRE.
     */
    public ActionResult executeOnceSync(String modelId, String transitionId,
                                        Map<String, List<Map<String, Object>>> boundTokens,
                                        Map<String, Object> credentialsOverride) {
        var maybeDefinition = transitionStore.get(modelId, transitionId);
        if (maybeDefinition.isEmpty()) {
            logger.warn("Cannot execute unknown transition: {}:{}", modelId, transitionId);
            return ActionResult.failure(Map.of(), Map.of("error", "Transition not found"));
        }
        if (!isCommandTransition(maybeDefinition.get())) {
            logger.warn("Rejecting executeOnceSync for non-command transition {}:{}", modelId, transitionId);
            return ActionResult.failure(Map.of(), Map.of("error", "Non-command actions run on master"));
        }
        return runSingleWithBoundTokens(maybeDefinition.get(), boundTokens, credentialsOverride);
    }

    private ActionResult runSingleWithBoundTokens(TransitionDefinition definition,
                                                  Map<String, List<Map<String, Object>>> boundTokens) {
        return runSingleWithBoundTokens(definition, boundTokens, null);
    }

    private ActionResult runSingleWithBoundTokens(TransitionDefinition definition,
                                                  Map<String, List<Map<String, Object>>> boundTokens,
                                                  Map<String, Object> credentialsOverride) {
        logger.info("🎯 Executing transition {} with bound tokens from master", definition.transitionId());
        Timer.Sample sample = Timer.start(meterRegistry);
        List<ReservedToken> reservedTokens = new ArrayList<>();

        try {
            // Convert bound tokens to TokenBinding format
            Map<String, ArcQueryResult.TokenBinding> selectedBindings = new HashMap<>();
            for (Map.Entry<String, List<Map<String, Object>>> entry : boundTokens.entrySet()) {
                String presetName = entry.getKey();
                List<Map<String, Object>> tokens = entry.getValue();

                if (tokens.isEmpty()) {
                    logger.warn("Preset {} has no bound tokens", presetName);
                    continue;
                }

                // For SINGLE mode, use first token
                Map<String, Object> tokenData = tokens.get(0);
                ArcQueryResult.TokenBinding binding = convertToTokenBinding(tokenData);
                selectedBindings.put(presetName, binding);
                logger.debug("  Preset '{}' → token: {}", presetName, binding.id());
            }
            reservedTokens = collectReservedTokens(definition, selectedBindings);

            // Execute action with bound tokens
            Map<String, Object> attributes = new HashMap<>();
            attributes.put("requestId", UUID.randomUUID().toString());
            // Credentials arrive as plaintext (from vault or legacy-decrypted by master)
            Map<String, Object> credentialsMap = credentialsOverride != null
                    ? credentialsOverride : definition.credentials();
            if (credentialsMap != null && !credentialsMap.isEmpty()) {
                attributes.put("credentials", credentialsMap);
            }
            TransitionContext context = new TransitionContext(definition.transitionId(), attributes);

            logger.info("Executing action for transition {} with {} bindings",
                       definition.transitionId(), selectedBindings.size());
            ActionResult result = actionExecutor.execute(definition, selectedBindings, context);

            if (shouldAbortAfterAction(definition.modelId(), definition.transitionId())) {
                releaseReservedTokensViaMaster(definition.transitionId(), reservedTokens);
                logger.info("⏹️ Skipping post-action side effects for transition {}:{} because local status is no longer runnable",
                        definition.modelId(), definition.transitionId());
                return result;
            }

            // Emit to postsets (delegates to master)
            emissionService.emit(definition, result);

            // Finalize reserved preset tokens via master.
            performConsumptionViaMaster(definition, selectedBindings);

            if (shouldAbortAfterAction(definition.modelId(), definition.transitionId())) {
                logger.info("⏹️ Transition {}:{} became non-runnable during finalization — skipping local bookkeeping",
                        definition.modelId(), definition.transitionId());
                return result;
            }

            if (!result.success()) {
                logger.warn("⚠️ Transition {}:{} action had failures but tokens were emitted and consumed",
                        definition.modelId(), definition.transitionId());
                transitionStore.recordError(definition.modelId(), definition.transitionId(), "Action had failures");
                meterRegistry.counter("transition.fire.failure", "transitionId", definition.transitionId()).increment();
            } else {
                transitionStore.markSuccess(definition.modelId(), definition.transitionId());
                meterRegistry.counter("transition.fire.success", "transitionId", definition.transitionId()).increment();
            }
            sample.stop(meterRegistry.timer("transition.fire.duration", "transitionId", definition.transitionId()));

            logger.info("✅ Transition {}:{} completed via bound tokens (success={})",
                    definition.modelId(), definition.transitionId(), result.success());
            return result;
        } catch (Exception e) {
            if (shouldAbortAfterAction(definition.modelId(), definition.transitionId())) {
                releaseReservedTokensViaMaster(definition.transitionId(), reservedTokens);
                logger.info("⏹️ Transition {}:{} stopped during command execution — preserving stop and releasing reservations",
                        definition.modelId(), definition.transitionId());
                sample.stop(meterRegistry.timer("transition.fire.duration", "transitionId", definition.transitionId()));
                return ActionResult.failure(Map.of(), Map.of("error", e.getMessage()));
            }
            logger.error("Transition {}:{} failed: {}", definition.modelId(), definition.transitionId(), e.getMessage(), e);
            transitionStore.recordError(definition.modelId(), definition.transitionId(), e.getMessage());
            meterRegistry.counter("transition.fire.failure", "transitionId", definition.transitionId()).increment();
            sample.stop(meterRegistry.timer("transition.fire.duration", "transitionId", definition.transitionId()));
            return ActionResult.failure(Map.of(), Map.of("error", e.getMessage()));
        }
    }

    /**
     * Convert master's bound token format to TokenBinding
     * Tokens from master have structure: {_meta: {id, name, parentId, type, properties}, ...otherFields}
     */
    private ArcQueryResult.TokenBinding convertToTokenBinding(Map<String, Object> tokenData) {
        // Extract values from _meta object (ArcQL result structure)
        String id = null;
        String name = null;
        String parentId = null;
        String type = "Leaf";
        Map<String, String> properties = new HashMap<>();

        logger.info("🔍 TOKEN CONVERSION: Received token with top-level keys: {}", tokenData.keySet());
        logger.info("🔍 TOKEN CONVERSION: Full token structure: {}", tokenData);

        Object metaObj = tokenData.get("_meta");
        logger.info("🔍 TOKEN CONVERSION: _meta object type: {}, value: {}",
                   metaObj != null ? metaObj.getClass().getSimpleName() : "null", metaObj);

        if (metaObj instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> metaMap = (Map<String, Object>) metaObj;

            id = (String) metaMap.get("id");
            name = (String) metaMap.get("name");
            parentId = (String) metaMap.get("parentId");
            type = (String) metaMap.getOrDefault("type", "Leaf");

            logger.debug("🔍 Extracted from _meta: id={}, name={}, parentId={}, type={}", id, name, parentId, type);

            // ✅ Extract properties from _meta.properties (includes _parentPlace enrichment!)
            Object propertiesObj = metaMap.get("properties");
            if (propertiesObj instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> propsMap = (Map<String, Object>) propertiesObj;

                // Convert all properties to String (TokenBinding expects Map<String, String>)
                for (Map.Entry<String, Object> entry : propsMap.entrySet()) {
                    properties.put(entry.getKey(), String.valueOf(entry.getValue()));
                }

                logger.debug("Extracted properties from _meta: {}", properties.keySet());
            }
        } else {
            // Fallback: try top-level fields (direct token format without _meta wrapper)
            // This supports calling executor directly with command tokens
            id = (String) tokenData.getOrDefault("id", UUID.randomUUID().toString());
            name = (String) tokenData.getOrDefault("name", "token");
            parentId = (String) tokenData.getOrDefault("parentId", "");
            type = (String) tokenData.getOrDefault("kind", "Leaf");

            // ✅ FIX: Populate properties from top-level fields for direct token format
            // This enables command tokens passed directly without _meta wrapper
            for (Map.Entry<String, Object> entry : tokenData.entrySet()) {
                String key = entry.getKey();
                Object value = entry.getValue();
                // Skip internal fields that are already extracted
                if (!"id".equals(key) && !"name".equals(key) && !"parentId".equals(key)) {
                    if (value instanceof String) {
                        properties.put(key, (String) value);
                    } else if (value instanceof Map || value instanceof List) {
                        // Serialize complex objects (like args) to JSON string
                        try {
                            com.fasterxml.jackson.databind.ObjectMapper tmpMapper = new com.fasterxml.jackson.databind.ObjectMapper();
                            properties.put(key, tmpMapper.writeValueAsString(value));
                        } catch (Exception e) {
                            properties.put(key, String.valueOf(value));
                        }
                    } else {
                        properties.put(key, String.valueOf(value));
                    }
                }
            }
            logger.debug("🔧 Extracted {} properties from top-level token fields", properties.size());
        }

        // Create dataNode populated with properties for template interpolation (e.g., ${email.data.subject})
        // CommandActionExecutor needs complex fields like 'args' to remain as JsonNode objects
        com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        com.fasterxml.jackson.databind.node.ObjectNode dataNode = mapper.createObjectNode();

        // For direct token format (no _meta), preserve original object types for complex fields
        if (metaObj == null) {
            // Directly convert the original tokenData to JsonNode to preserve object structure
            for (Map.Entry<String, Object> entry : tokenData.entrySet()) {
                String key = entry.getKey();
                Object value = entry.getValue();
                if (value instanceof Map || value instanceof List) {
                    // Preserve complex objects as JsonNode (critical for args field)
                    dataNode.set(key, mapper.valueToTree(value));
                } else if (value instanceof String) {
                    dataNode.put(key, (String) value);
                } else if (value instanceof Number) {
                    dataNode.put(key, ((Number) value).doubleValue());
                } else if (value instanceof Boolean) {
                    dataNode.put(key, (Boolean) value);
                } else {
                    dataNode.put(key, String.valueOf(value));
                }
            }
        } else {
            // For _meta format, first check if there's a 'data' field to extract
            // This handles tokens with structure: {"data": {...}, "_meta": {...}}
            Object dataObj = tokenData.get("data");
            if (dataObj != null) {
                logger.debug("🔧 Found 'data' field in token, extracting to dataNode");
                if (dataObj instanceof Map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> dataMap = (Map<String, Object>) dataObj;

                    // Check for double-nested data: {"data": {"data": "stringified JSON"}}
                    Object innerData = dataMap.get("data");
                    if (innerData instanceof String && ((String) innerData).startsWith("{")) {
                        String innerDataStr = (String) innerData;
                        try {
                            com.fasterxml.jackson.databind.JsonNode parsedData = mapper.readTree(innerDataStr);
                            logger.info("🔧 Unwrapped double-nested data.data string to JSON object");
                            // Use the parsed data directly
                            parsedData.fields().forEachRemaining(field -> {
                                dataNode.set(field.getKey(), field.getValue());
                            });
                            logger.debug("🔧 Created dataNode with {} fields from unwrapped data", dataNode.size());
                            return new ArcQueryResult.TokenBinding(id, name, parentId, type, properties, dataNode, null);
                        } catch (Exception e) {
                            logger.warn("⚠️ Failed to parse data.data string as JSON: {}", e.getMessage());
                        }
                    }

                    // Normal data map processing
                    for (Map.Entry<String, Object> entry : dataMap.entrySet()) {
                        String key = entry.getKey();
                        Object value = entry.getValue();
                        if (value instanceof Map || value instanceof List) {
                            dataNode.set(key, mapper.valueToTree(value));
                        } else if (value instanceof String) {
                            // Check if string is JSON that should be parsed
                            String strValue = (String) value;
                            if ((strValue.startsWith("{") || strValue.startsWith("[")) &&
                                ("args".equals(key) || "meta".equals(key))) {
                                try {
                                    com.fasterxml.jackson.databind.JsonNode parsed = mapper.readTree(strValue);
                                    dataNode.set(key, parsed);
                                } catch (Exception e) {
                                    dataNode.put(key, strValue);
                                }
                            } else {
                                dataNode.put(key, strValue);
                            }
                        } else if (value instanceof Number) {
                            dataNode.put(key, ((Number) value).doubleValue());
                        } else if (value instanceof Boolean) {
                            dataNode.put(key, (Boolean) value);
                        } else {
                            dataNode.put(key, String.valueOf(value));
                        }
                    }
                    logger.debug("🔧 Created dataNode with {} fields from data map", dataNode.size());
                    return new ArcQueryResult.TokenBinding(id, name, parentId, type, properties, dataNode, null);
                } else if (dataObj instanceof String) {
                    // data is a stringified JSON
                    String dataStr = (String) dataObj;
                    if (dataStr.startsWith("{") || dataStr.startsWith("[")) {
                        try {
                            com.fasterxml.jackson.databind.JsonNode parsedData = mapper.readTree(dataStr);
                            logger.info("🔧 Parsed stringified 'data' field to JSON object");
                            parsedData.fields().forEachRemaining(field -> {
                                dataNode.set(field.getKey(), field.getValue());
                            });
                            logger.debug("🔧 Created dataNode with {} fields from parsed data", dataNode.size());
                            return new ArcQueryResult.TokenBinding(id, name, parentId, type, properties, dataNode, null);
                        } catch (Exception e) {
                            logger.warn("⚠️ Failed to parse 'data' string as JSON: {}", e.getMessage());
                        }
                    }
                }
            }

            // Fallback: populate from string properties (template interpolation use case)
            // Special handling for 'command' or 'command_token' property that contains full CommandToken JSON
            // and 'args' field: if it's a JSON string, parse it to JsonNode

            // First, check if 'command' or 'command_token' property contains a full CommandToken JSON
            // Some tokens use 'command' as property name, others use 'command_token'
            String commandProp = properties.get("command");
            if (commandProp == null) {
                commandProp = properties.get("command_token");  // Try alternate property name
            }
            if (commandProp != null && commandProp.startsWith("{") && commandProp.contains("\"kind\"")) {
                try {
                    com.fasterxml.jackson.databind.JsonNode parsedCommand = mapper.readTree(commandProp);
                    // Check if this is a CommandToken structure
                    if (parsedCommand.has("kind") && "command".equals(parsedCommand.get("kind").asText())) {
                        logger.info("🔧 Detected CommandToken JSON in 'command'/'command_token' property, extracting fields");
                        // Extract all CommandToken fields to dataNode
                        parsedCommand.fields().forEachRemaining(field -> {
                            dataNode.set(field.getKey(), field.getValue());
                        });
                        logger.debug("🔧 Extracted CommandToken fields: {}", dataNode.fieldNames());
                        // Skip normal property processing since we've extracted everything
                        logger.debug("🔧 Created dataNode with {} fields for template interpolation", dataNode.size());
                        return new ArcQueryResult.TokenBinding(id, name, parentId, type, properties, dataNode, null);
                    }
                } catch (Exception e) {
                    logger.warn("⚠️ Failed to parse 'command'/'command_token' property as CommandToken JSON: {}", e.getMessage());
                    // Fall through to normal processing
                }
            }

            // Normal property processing
            for (Map.Entry<String, String> entry : properties.entrySet()) {
                String key = entry.getKey();
                String value = entry.getValue();

                if ("args".equals(key) && value != null && (value.startsWith("{") || value.startsWith("["))) {
                    // Parse JSON string to JsonNode for 'args' field (required by CommandToken)
                    try {
                        com.fasterxml.jackson.databind.JsonNode parsedArgs = mapper.readTree(value);
                        dataNode.set(key, parsedArgs);
                        logger.debug("🔧 Parsed 'args' string to JsonNode: {}", value);
                    } catch (Exception e) {
                        // Fallback: put as string if parsing fails
                        dataNode.put(key, value);
                        logger.warn("⚠️ Failed to parse 'args' as JSON, using as string: {}", e.getMessage());
                    }
                } else {
                    dataNode.put(key, value);
                }
            }
        }

        logger.debug("🔧 Created dataNode with {} fields for template interpolation", dataNode.size());

        return new ArcQueryResult.TokenBinding(id, name, parentId, type, properties, dataNode, null);
    }

    /**
     * Finalize reserved preset tokens via master:
     * consume when consume=true, otherwise just release the reservation lock.
     */
    private void performConsumptionViaMaster(TransitionDefinition definition,
                                            Map<String, ArcQueryResult.TokenBinding> bindings) {
        var inscription = definition.inscription();

        // Iterate through presets and consume tokens if consume=true
        for (Map.Entry<String, ArcQueryResult.TokenBinding> entry : bindings.entrySet()) {
            String presetName = entry.getKey();
            ArcQueryResult.TokenBinding binding = entry.getValue();

            // ✅ _parentPlace should already be in binding.properties() from master's enrichment
            // DO NOT overwrite it here!

            // Get preset configuration
            TransitionInscription.Preset preset = inscription.presets().get(presetName);
            if (preset == null) {
                logger.warn("Preset {} not found in inscription, skipping consumption", presetName);
                continue;
            }

            // Check if this preset should consume tokens
            if (Boolean.TRUE.equals(preset.consume())) {
                logger.info("🗑️ Consuming token from preset '{}' via master", presetName);

                // ✅ FIX: Extract modelId from host string (format: "{modelId}@{host}:{port}")
                String host = preset.host();
                String modelId = HostUtil.extractModelId(host);
                if (modelId == null || modelId.isBlank()) {
                    throw new IllegalStateException("Cannot extract modelId from host: " + host);
                }

                // Delegate consumption to master
                consumptionService.consume(host, modelId, List.of(binding));
            } else {
                logger.debug("Preset '{}' has consume=false, releasing token lock via master", presetName);
                String host = preset.host();
                String modelId = HostUtil.extractModelId(host);
                if (modelId == null || modelId.isBlank()) {
                    throw new IllegalStateException("Cannot extract modelId from host: " + host);
                }
                consumptionService.release(host, modelId, List.of(binding));
            }
        }
    }

    private List<ReservedToken> collectReservedTokens(TransitionDefinition definition,
                                                      Map<String, ArcQueryResult.TokenBinding> bindings) {
        List<ReservedToken> reservedTokens = new ArrayList<>();
        var inscription = definition.inscription();

        for (Map.Entry<String, ArcQueryResult.TokenBinding> entry : bindings.entrySet()) {
            String presetName = entry.getKey();
            TransitionInscription.Preset preset = inscription.presets().get(presetName);
            if (preset == null) {
                logger.warn("Preset {} not found in inscription, skipping reservation tracking", presetName);
                continue;
            }

            String host = preset.host();
            String modelId = HostUtil.extractModelId(host);
            if (modelId == null || modelId.isBlank()) {
                modelId = definition.modelId();
            }

            reservedTokens.add(new ReservedToken(host, modelId, entry.getValue(), preset));
        }

        return reservedTokens;
    }

    private void releaseReservedTokensViaMaster(String transitionId, List<ReservedToken> reservedTokens) {
        if (reservedTokens == null || reservedTokens.isEmpty()) {
            return;
        }

        for (ReservedToken reservedToken : reservedTokens) {
            logger.info("🔓 Releasing reserved token for transition {} via master (preset host={})",
                    transitionId, reservedToken.host());
            consumptionService.release(
                    reservedToken.host(),
                    reservedToken.modelId(),
                    List.of(reservedToken.binding())
            );
        }
    }

    private boolean shouldAbortAfterAction(String modelId, String transitionId) {
        var latest = transitionStore.get(modelId, transitionId);
        if (latest.isEmpty()) {
            return true;
        }
        return !isRunnable(latest.get().status());
    }

    @PreDestroy
    public void shutdown() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            executor.shutdownNow();
        }
    }

    private record ReservedToken(String host,
                                 String modelId,
                                 ArcQueryResult.TokenBinding binding,
                                 TransitionInscription.Preset preset) {
    }

    private boolean isCommandTransition(TransitionDefinition definition) {
        return definition != null
                && definition.inscription() != null
                && definition.inscription().action() != null
                && "command".equals(definition.inscription().action().type());
    }
}
