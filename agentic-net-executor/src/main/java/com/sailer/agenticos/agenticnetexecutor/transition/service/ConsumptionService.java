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

        List<MasterPollingService.TokenReference> tokenReferences = toTokenReferences(tokens, "CONSUMPTION");

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

    public void release(String host,
                        String modelId,
                        List<ArcQueryResult.TokenBinding> tokens) {
        if (tokens == null || tokens.isEmpty()) {
            return;
        }

        List<MasterPollingService.TokenReference> tokenReferences = toTokenReferences(tokens, "RELEASE");

        logger.info("🔓 Releasing {} token locks from model '{}' via master", tokenReferences.size(), modelId);
        try {
            masterPollingService.releaseTokens(modelId, tokenReferences).block();
            logger.info("✅ Successfully released {} token locks via master", tokenReferences.size());
        } catch (Exception ex) {
            logger.error("❌ Failed to release token locks via master: {}", ex.getMessage(), ex);
            throw new IllegalStateException("Token lock release via master failed", ex);
        }
    }

    private List<MasterPollingService.TokenReference> toTokenReferences(List<ArcQueryResult.TokenBinding> tokens,
                                                                        String operationName) {
        logger.info("🔍 {}: Processing {} tokens", operationName, tokens.size());
        List<MasterPollingService.TokenReference> tokenReferences = new ArrayList<>();
        for (ArcQueryResult.TokenBinding token : tokens) {
            logger.debug("🔍 {}: Examining token id={}, name={}", operationName, token.id(), token.name());

            String parentPlace = null;
            if (token.properties() != null && token.properties().containsKey("_parentPlace")) {
                parentPlace = token.properties().get("_parentPlace");
                logger.info("✅ {}: Extracted _parentPlace='{}' from token.properties() for id={}",
                        operationName, parentPlace, token.id());
            } else {
                logger.warn("⚠️ {}: No _parentPlace in token.properties() for token id={}", operationName, token.id());
                if (token.properties() != null) {
                    logger.debug("🔍 {}: Available property keys: {}", operationName, token.properties().keySet());
                }
            }

            String effectiveParentId = (parentPlace != null && !parentPlace.isBlank())
                    ? parentPlace
                    : token.parentId();

            if (effectiveParentId == null || effectiveParentId.isBlank()) {
                logger.error("❌ {}: Token {} has no parent place information", operationName, token.id());
            } else {
                logger.info("✅ {}: Using effectiveParentId='{}' for token id={}",
                        operationName, effectiveParentId, token.id());
            }

            MasterPollingService.TokenReference ref = new MasterPollingService.TokenReference(
                    token.id(),
                    effectiveParentId,
                    token.name()
            );
            tokenReferences.add(ref);
            logger.info("📝 {}: Prepared TokenReference(id={}, parentId={}, name={})",
                    operationName, token.id(), effectiveParentId, token.name());
        }
        return tokenReferences;
    }
}
