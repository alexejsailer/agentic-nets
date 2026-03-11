package com.sailer.agenticos.agenticnetgateway.service;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * In-memory registry of master nodes. Each master declares which modelIds it serves
 * (or "*" for all). The gateway routes requests to the correct master based on these
 * declarations.
 *
 * <p>On startup, if {@code gateway.master-url} is configured, auto-registers a "seed-master"
 * with models=["*"] that is never evicted — ensuring backward compatibility with single-master
 * deployments.</p>
 *
 * <p>When a new modelId is seen and no explicit master is declared for it, the next wildcard
 * master is assigned via round-robin.</p>
 */
@Service
public class MasterRegistryService {

    private static final Logger logger = LoggerFactory.getLogger(MasterRegistryService.class);

    public record MasterNode(String masterId, String url, List<String> models,
                              Instant registeredAt, Instant lastHeartbeat, boolean seed) {}

    private final ConcurrentHashMap<String, MasterNode> masters = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> modelToMaster = new ConcurrentHashMap<>();
    private final AtomicInteger roundRobinCounter = new AtomicInteger(0);
    private final GatewayProperties props;

    public MasterRegistryService(GatewayProperties props) {
        this.props = props;
    }

    @PostConstruct
    void init() {
        String masterUrl = props.getMasterUrl();
        if (masterUrl != null && !masterUrl.isBlank()) {
            logger.info("Auto-registering seed master at {}", masterUrl);
            register("seed-master", masterUrl, List.of("*"), true);
        }
    }

    /**
     * Register a master node. If models != ["*"], adds explicit model-to-master mappings.
     */
    public void register(String masterId, String url, List<String> models) {
        register(masterId, url, models, false);
    }

    private void register(String masterId, String url, List<String> models, boolean seed) {
        Instant now = Instant.now();
        MasterNode node = new MasterNode(masterId, url, models, now, now, seed);
        masters.put(masterId, node);

        if (!models.contains("*")) {
            for (String model : models) {
                modelToMaster.put(model, masterId);
                logger.info("Explicit model mapping: {} -> {}", model, masterId);
            }
        }

        logger.info("Registered master: id={}, url={}, models={}, seed={}", masterId, url, models, seed);
    }

    public void heartbeat(String masterId) {
        masters.computeIfPresent(masterId, (id, existing) ->
                new MasterNode(id, existing.url(), existing.models(), existing.registeredAt(),
                        Instant.now(), existing.seed()));
    }

    public void deregister(String masterId) {
        MasterNode removed = masters.remove(masterId);
        if (removed != null) {
            // Remove model mappings that pointed to this master
            modelToMaster.entrySet().removeIf(e -> e.getValue().equals(masterId));
            logger.info("Deregistered master: {}", masterId);
        }
    }

    public List<MasterNode> getActiveMasters() {
        return new ArrayList<>(masters.values());
    }

    /**
     * Resolve which master handles a given modelId.
     * <ol>
     *   <li>Check modelToMaster map (explicit or previously assigned)</li>
     *   <li>If not found, pick a wildcard master via round-robin, store the mapping</li>
     *   <li>If no masters available, throw NoMasterAvailableException</li>
     * </ol>
     */
    public MasterNode resolveMasterForModel(String modelId) {
        if (modelId != null) {
            String mappedMasterId = modelToMaster.get(modelId);
            if (mappedMasterId != null) {
                MasterNode node = masters.get(mappedMasterId);
                if (node != null) {
                    return node;
                }
                // Stale mapping — master was deregistered
                modelToMaster.remove(modelId);
            }
        }

        // Find wildcard masters
        List<MasterNode> wildcards = masters.values().stream()
                .filter(m -> m.models().contains("*"))
                .toList();

        if (!wildcards.isEmpty()) {
            int idx = Math.abs(roundRobinCounter.getAndIncrement() % wildcards.size());
            MasterNode chosen = wildcards.get(idx);
            if (modelId != null) {
                modelToMaster.put(modelId, chosen.masterId());
                logger.info("Round-robin assigned model {} -> {}", modelId, chosen.masterId());
            }
            return chosen;
        }

        // Fallback: return any master if available
        if (!masters.isEmpty()) {
            return masters.values().iterator().next();
        }

        throw new NoMasterAvailableException("No master available for model: " + modelId);
    }

    /**
     * For fan-out: get all masters that might have assignments for given models.
     * If models is null/empty or contains "*", returns all active masters.
     * Otherwise returns masters mapped to those models.
     */
    public List<MasterNode> mastersForModels(List<String> models) {
        if (models == null || models.isEmpty() || models.contains("*")) {
            return getActiveMasters();
        }

        List<MasterNode> result = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();

        for (String model : models) {
            String masterId = modelToMaster.get(model);
            if (masterId != null && seen.add(masterId)) {
                MasterNode node = masters.get(masterId);
                if (node != null) {
                    result.add(node);
                }
            }
        }

        // Also include all wildcard masters
        for (MasterNode m : masters.values()) {
            if (m.models().contains("*") && seen.add(m.masterId())) {
                result.add(m);
            }
        }

        return result.isEmpty() ? getActiveMasters() : result;
    }

    @Scheduled(fixedDelay = 10_000)
    void evictStale() {
        int ttl = props.getMasterHeartbeatTtlSeconds();
        Instant cutoff = Instant.now().minusSeconds(ttl);

        masters.entrySet().removeIf(entry -> {
            MasterNode node = entry.getValue();
            if (node.seed()) {
                return false; // Never evict seed masters
            }
            if (node.lastHeartbeat().isBefore(cutoff)) {
                logger.warn("Evicting stale master: {} (last heartbeat: {})", node.masterId(), node.lastHeartbeat());
                modelToMaster.entrySet().removeIf(e -> e.getValue().equals(node.masterId()));
                return true;
            }
            return false;
        });
    }

    public static class NoMasterAvailableException extends RuntimeException {
        public NoMasterAvailableException(String message) {
            super(message);
        }
    }
}
