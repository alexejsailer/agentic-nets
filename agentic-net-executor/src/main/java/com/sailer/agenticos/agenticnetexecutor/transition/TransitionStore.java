package com.sailer.agenticos.agenticnetexecutor.transition;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.stream.Collectors;

/**
 * In-memory store for transition definitions keyed by composite modelId:transitionId.
 */
public class TransitionStore {

    private static final Logger logger = LoggerFactory.getLogger(TransitionStore.class);

    private final ConcurrentMap<String, TransitionDefinition> transitions = new ConcurrentHashMap<>();

    private static String key(String modelId, String transitionId) {
        return modelId + ":" + transitionId;
    }

    public Optional<TransitionDefinition> get(String modelId, String transitionId) {
        return Optional.ofNullable(transitions.get(key(modelId, transitionId)));
    }

    public Collection<TransitionDefinition> list() {
        return transitions.values();
    }

    public List<TransitionDefinition> listByModel(String modelId) {
        String prefix = modelId + ":";
        return transitions.entrySet().stream()
                .filter(e -> e.getKey().startsWith(prefix))
                .map(Map.Entry::getValue)
                .collect(Collectors.toList());
    }

    public Set<String> modelIds() {
        return transitions.values().stream()
                .map(TransitionDefinition::modelId)
                .collect(Collectors.toSet());
    }

    public TransitionDefinition register(TransitionDefinition definition) {
        String k = key(definition.modelId(), definition.transitionId());
        transitions.compute(k, (id, existing) -> {
            if (existing != null) {
                throw new IllegalStateException("Transition already registered: " + id);
            }
            logger.info("Registering transition {}:{} with presets {}",
                    definition.modelId(), definition.transitionId(),
                    definition.inscription().presets().keySet());
            return definition;
        });
        return definition;
    }

    public Optional<TransitionDefinition> remove(String modelId, String transitionId) {
        TransitionDefinition removed = transitions.remove(key(modelId, transitionId));
        if (removed != null) {
            logger.info("Removed transition {}:{}", modelId, transitionId);
        }
        return Optional.ofNullable(removed);
    }

    public TransitionDefinition replace(TransitionDefinition definition) {
        transitions.put(key(definition.modelId(), definition.transitionId()), definition);
        logger.info("Replaced transition {}:{}", definition.modelId(), definition.transitionId());
        return definition;
    }

    public void updateStatus(String modelId, String transitionId, TransitionStatus status) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.markStatus(status);
            return definition;
        });
    }

    public void recordError(String modelId, String transitionId, String error) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.recordError(error);
            return definition;
        });
    }

    public void clearError(String modelId, String transitionId) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.clearError();
            return definition;
        });
    }

    public Map<String, TransitionDefinition> snapshot() {
        return Map.copyOf(transitions);
    }

    public void markStart(String modelId, String transitionId) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.metrics().markStart();
            definition.markStatus(TransitionStatus.RUNNING);
            return definition;
        });
    }

    public void markStop(String modelId, String transitionId) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.metrics().markStop();
            definition.markStatus(TransitionStatus.STOPPED);
            return definition;
        });
    }

    public void markSuccess(String modelId, String transitionId) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.metrics().markSuccess();
            return definition;
        });
    }

    public void markFailure(String modelId, String transitionId, String error) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.metrics().markFailure();
            definition.recordError(error);
            return definition;
        });
    }

    public void ensureRegistered(String modelId, String transitionId) {
        if (!transitions.containsKey(key(modelId, transitionId))) {
            throw new IllegalArgumentException("Transition not found: " + modelId + ":" + transitionId);
        }
    }

    public void touch(String modelId, String transitionId) {
        transitions.computeIfPresent(key(modelId, transitionId), (id, definition) -> {
            definition.markStatus(definition.status());
            return definition;
        });
    }

    public void clear() {
        transitions.clear();
    }
}
