package com.sailer.agenticos.agenticnetexecutor.transition.service;

import com.sailer.agenticos.agenticnetexecutor.service.MasterPollingService;
import com.sailer.agenticos.agenticnetexecutor.transition.dto.ArcQueryResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

public class ConsumptionService {

    private static final Logger logger = LoggerFactory.getLogger(ConsumptionService.class);

    private final MasterPollingService masterPollingService;

    public ConsumptionService(MasterPollingService masterPollingService) {
        this.masterPollingService = Objects.requireNonNull(masterPollingService, "masterPollingService");
    }

    public void consume(String host,
                        String modelId,
                        List<ArcQueryResult.TokenBinding> tokens) {
        if (tokens == null || tokens.isEmpty()) {
            return;
        }

        // Log what we're about to consume
        logger.debug("🗑️ Consumption requested: {} elements on model {}", tokens.size(), modelId);
        for (ArcQueryResult.TokenBinding token : tokens) {
            logger.debug("  → {} '{}' (type={}, id={}, parent={})",
                    token.type(), token.name(), token.type(), token.id(), token.parentId());

            // Info: Consuming a Node (container) will cascade delete all children
            // This is sometimes intentional (e.g., cleaning up task groups)
            if ("Node".equals(token.type())) {
                logger.info("ℹ️ Consuming Node '{}' (id={}) - will cascade delete all children",
                        token.name(), token.id());
            }
        }

        // Convert TokenBindings to TokenReference DTOs for master
        logger.info("🔍 CONSUMPTION: Processing {} tokens for deletion from model '{}'", tokens.size(), modelId);
        List<MasterPollingService.TokenReference> tokenReferences = new ArrayList<>();
        for (ArcQueryResult.TokenBinding token : tokens) {
            logger.debug("🔍 CONSUMPTION: Examining token id={}, name={}", token.id(), token.name());
            logger.debug("🔍 CONSUMPTION: Token data present: {}, has _parentPlace: {}",
                        token.data() != null,
                        token.data() != null && token.data().has("_parentPlace"));

            // ✅ FIX #4: Extract parent place from token properties (enriched by master during token binding)
            // Master adds "_parentPlace" field during bindTokensForPresets() in TransitionOrchestrationService
            // This gets stored in _meta.properties and extracted to token.properties() in TokenBinding
            String parentPlace = null;
            if (token.properties() != null && token.properties().containsKey("_parentPlace")) {
                parentPlace = token.properties().get("_parentPlace");
                logger.info("✅ CONSUMPTION: Extracted _parentPlace='{}' from token.properties() for id={}", parentPlace, token.id());
            } else {
                logger.warn("⚠️ CONSUMPTION: No _parentPlace in token.properties() for token id={}", token.id());
                if (token.properties() != null) {
                    logger.debug("🔍 CONSUMPTION: Available property keys: {}", token.properties().keySet());
                }
            }

            // Use extracted parent place or fall back to token.parentId()
            String effectiveParentId = (parentPlace != null && !parentPlace.isBlank())
                    ? parentPlace
                    : token.parentId();

            if (effectiveParentId == null || effectiveParentId.isBlank()) {
                logger.error("❌ CONSUMPTION: Token {} has no parent place information - cannot delete without knowing parent location", token.id());
            } else {
                logger.info("✅ CONSUMPTION: Using effectiveParentId='{}' for token id={}", effectiveParentId, token.id());
            }

            MasterPollingService.TokenReference ref = new MasterPollingService.TokenReference(
                    token.id(),
                    effectiveParentId,  // ✅ Use extracted _parentPlace
                    token.name()
            );
            tokenReferences.add(ref);
            logger.info("📝 CONSUMPTION: Prepared TokenReference(id={}, parentId={}, name={})",
                        token.id(), effectiveParentId, token.name());
        }

        // Delegate to master to delete tokens from agentic-net-node
        logger.info("🗑️ Consuming {} tokens from model '{}' via master", tokenReferences.size(), modelId);
        try {
            masterPollingService.consumeTokens(modelId, tokenReferences).block();
            logger.info("✅ Successfully consumed {} tokens via master", tokenReferences.size());
        } catch (Exception ex) {
            logger.error("❌ Failed to consume tokens via master: {}", ex.getMessage(), ex);
            throw new IllegalStateException("Token consumption via master failed", ex);
        }
    }
}
