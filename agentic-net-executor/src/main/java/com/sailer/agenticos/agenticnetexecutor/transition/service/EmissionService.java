package com.sailer.agenticos.agenticnetexecutor.transition.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetexecutor.service.MasterPollingService;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.runtime.ActionResult;
import com.sailer.agenticos.agenticnetexecutor.transition.runtime.EmissionPayload;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

public class EmissionService {

    private static final Logger logger = LoggerFactory.getLogger(EmissionService.class);

    private final ObjectMapper objectMapper;
    private final MasterPollingService masterPollingService;
    public EmissionService(ObjectMapper objectMapper,
                           MasterPollingService masterPollingService) {
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper");
        this.masterPollingService = masterPollingService;
    }

    /**
     * Emit tokens based on action result.
     */
    public void emit(TransitionDefinition definition,
                     ActionResult result) {
        emitStandard(definition, result);
    }

    /**
     * Standard emission for command actions using successPayloads/errorPayloads.
     */
    private void emitStandard(TransitionDefinition definition, ActionResult result) {
        boolean success = result.success();
        // For failed actions, merge both success and error payloads to emit catch-all rules
        Map<String, List<EmissionPayload>> payloadSource;
        if (success) {
            payloadSource = result.successPayloads();
        } else {
            // On failure, emit from errorPayloads but also include successPayloads
            // (catch-all emit rules that matched both phases produce payloads in both)
            payloadSource = new java.util.HashMap<>(result.errorPayloads());
            // Also check successPayloads in case rules matched during error phase
            result.successPayloads().forEach((key, value) ->
                    payloadSource.merge(key, value, (existing, newVal) -> {
                        var merged = new ArrayList<>(existing);
                        merged.addAll(newVal);
                        return merged;
                    })
            );
        }
        if (payloadSource.isEmpty()) {
            logger.warn("⚠️ No payloads to emit for transition {} (success={}, errorPayloads={}, successPayloads={})",
                    definition.transitionId(), success,
                    result.errorPayloads().size(), result.successPayloads().size());
            return;
        }
        logger.info("📦 Payload source has {} postsets for transition {} (success={})",
                payloadSource.size(), definition.transitionId(), success);

        // Collect all emissions to send to master in one batch
        List<MasterPollingService.TokenEmission> allEmissions = new ArrayList<>();
        String targetModelId = null;

        for (Map.Entry<String, List<EmissionPayload>> entry : payloadSource.entrySet()) {
            String postsetId = entry.getKey();
            TransitionInscription.Postset postset = definition.inscription().postsets().get(postsetId);
            if (postset == null) {
                logger.warn("Unknown postset {} for transition {}", postsetId, definition.transitionId());
                continue;
            }
            String host = postset.host();
            String placeId = postset.placeId();

            // Parse host format: either "{modelId}@{host}:{port}" or just "{host}:{port}"
            if (host.contains("@")) {
                int atIndex = host.indexOf('@');
                targetModelId = host.substring(0, atIndex);
            }

            // Resolve placeId to UUID if needed
            String resolvedPlaceId = placeId;
            if (!isUUID(placeId)) {
                logger.debug("Resolving place name '{}' to UUID for postset '{}'", placeId, postsetId);
                // For now, use the place name as-is - master will resolve it
                // In production, we might want to resolve here or have master handle it
                resolvedPlaceId = placeId;
            }

            for (EmissionPayload payload : entry.getValue()) {
                JsonNode data = payload.data();
                if (data == null || data.isMissingNode() || data.isNull()) {
                    logger.warn("⚠️ Skipping emission for token with null/missing data to postset {} for transition {}",
                            postsetId, definition.transitionId());
                    continue;
                }
                String tokenName = payload.effectiveName(generateDefaultName(definition.transitionId()));
                JsonNode enriched = enrichPayload(data, definition.transitionId(), success);

                // Convert JsonNode to Map<String, Object>
                Map<String, Object> tokenData = convertJsonNodeToMap(enriched);

                // Create emission record for master
                MasterPollingService.TokenEmission emission = new MasterPollingService.TokenEmission(
                        resolvedPlaceId,
                        tokenName,
                        tokenData
                );
                allEmissions.add(emission);

                logger.debug("Prepared emission: token '{}' to place '{}' (postset '{}')",
                        tokenName, resolvedPlaceId, postsetId);
            }
        }

        // Delegate to master to store tokens in agentic-net-node
        if (!allEmissions.isEmpty() && targetModelId != null) {
            logger.info("🔼 Emitting {} tokens to model '{}' via master", allEmissions.size(), targetModelId);
            try {
                masterPollingService.emitTokens(targetModelId, allEmissions).block();
                logger.info("✅ Successfully emitted {} tokens via master", allEmissions.size());
            } catch (Exception ex) {
                logger.error("❌ Failed to emit tokens via master: {}", ex.getMessage(), ex);
                throw new IllegalStateException("Token emission via master failed", ex);
            }
        } else if (allEmissions.isEmpty()) {
            logger.debug("No tokens to emit");
        } else {
            logger.warn("Cannot emit tokens - no target model ID extracted from host");
        }
    }

    /**
     * Convert JsonNode to Map<String, Object> for master API
     */
    private Map<String, Object> convertJsonNodeToMap(JsonNode node) {
        try {
            return objectMapper.convertValue(node, Map.class);
        } catch (Exception e) {
            logger.warn("Failed to convert JsonNode to Map, using fallback: {}", e.getMessage());
            Map<String, Object> fallback = new HashMap<>();
            fallback.put("value", node.toString());
            return fallback;
        }
    }

    private JsonNode enrichPayload(JsonNode payload, String transitionId, boolean success) {
        if (!payload.isObject()) {
            ObjectNode wrapper = objectMapper.createObjectNode();
            wrapper.set("value", payload);
            wrapper.put("transitionId", transitionId);
            wrapper.put("emittedAt", Instant.now().toString());
            wrapper.put("status", success ? "success" : "error");
            return wrapper;
        }
        ObjectNode objectNode = (ObjectNode) payload.deepCopy();

        // Strip lock properties before emission to postset
        objectNode.remove("_lock");
        objectNode.remove("_lockExpires");

        if (!objectNode.has("transitionId")) {
            objectNode.put("transitionId", transitionId);
        }
        objectNode.put("emittedAt", Instant.now().toString());
        objectNode.put("status", success ? "success" : "error");
        return objectNode;
    }

    private String generateDefaultName(String transitionId) {
        return transitionId + "-" + UUID.randomUUID();
    }

    private boolean isUUID(String str) {
        if (str == null || str.length() != 36) {
            return false;
        }
        try {
            UUID.fromString(str);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

}
