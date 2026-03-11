package com.sailer.agenticos.agenticnetexecutor.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStatus;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Service for polling upstream (master or gateway) for assigned work across all models.
 * Supports two upstream modes:
 * <ul>
 *   <li>Direct master (no auth): {@code executor.upstream.url=http://localhost:8082}</li>
 *   <li>Through gateway (JWT auth): {@code executor.upstream.url=http://localhost:8083}
 *       with client-id and client-secret set</li>
 * </ul>
 */
@Service
public class MasterPollingService {

    private static final Logger logger = LoggerFactory.getLogger(MasterPollingService.class);
    private static final ObjectMapper objectMapper = new ObjectMapper();

    private final WebClient webClient;
    private final String upstreamUrl;
    private final String executorId;
    private final TransitionStore transitionStore;
    private final com.sailer.agenticos.agenticnetexecutor.transition.runtime.TransitionOrchestrator orchestrator;

    // JWT token management (only when auth is configured)
    private final boolean authEnabled;
    private final String clientId;
    private final String clientSecret;
    private final String configuredModels;
    private final AtomicReference<String> jwtToken = new AtomicReference<>();
    private final AtomicReference<Instant> tokenExpiry = new AtomicReference<>(Instant.EPOCH);

    // Discovered model IDs from upstream
    final Set<String> discoveredModelIds = ConcurrentHashMap.newKeySet();

    public MasterPollingService(
            @Value("${executor.upstream.url:http://localhost:8082}") String upstreamUrl,
            @Value("${executor.id:agentic-net-executor-default}") String executorId,
            @Value("${executor.upstream.auth.client-id:}") String clientId,
            @Value("${executor.upstream.auth.client-secret:}") String clientSecret,
            @Value("${executor.models:*}") String configuredModels,
            TransitionStore transitionStore,
            @Lazy com.sailer.agenticos.agenticnetexecutor.transition.runtime.TransitionOrchestrator orchestrator) {
        this.upstreamUrl = upstreamUrl;
        this.executorId = executorId;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.configuredModels = configuredModels;
        this.authEnabled = clientId != null && !clientId.isBlank()
                && clientSecret != null && !clientSecret.isBlank();
        this.transitionStore = transitionStore;
        this.orchestrator = orchestrator;

        WebClient.Builder builder = WebClient.builder().baseUrl(upstreamUrl);
        if (authEnabled) {
            builder.filter(jwtAuthFilter());
        }
        this.webClient = builder.build();

        logger.info("MasterPollingService initialized: upstreamUrl={}, executorId={}, auth={}",
                upstreamUrl, executorId, authEnabled ? "JWT" : "none");
    }

    // -------------------------------------------------------------------------
    // JWT Auth
    // -------------------------------------------------------------------------

    private ExchangeFilterFunction jwtAuthFilter() {
        return (request, next) -> ensureToken()
                .flatMap(token -> {
                    ClientRequest authed = ClientRequest.from(request)
                            .header("Authorization", "Bearer " + token)
                            .build();
                    return next.exchange(authed);
                });
    }

    private Mono<String> ensureToken() {
        String existing = jwtToken.get();
        if (existing != null && Instant.now().isBefore(tokenExpiry.get())) {
            return Mono.just(existing);
        }
        return fetchToken();
    }

    private Mono<String> fetchToken() {
        return WebClient.create(upstreamUrl)
                .post()
                .uri("/oauth2/token")
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .bodyValue("grant_type=client_credentials&client_id=" + clientId
                        + "&client_secret=" + clientSecret)
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(Duration.ofSeconds(10))
                .map(body -> {
                    String token = (String) body.get("access_token");
                    int expiresIn = body.containsKey("expires_in")
                            ? ((Number) body.get("expires_in")).intValue() : 3600;
                    // Refresh 60s before actual expiry
                    jwtToken.set(token);
                    tokenExpiry.set(Instant.now().plusSeconds(expiresIn - 60));
                    logger.info("JWT token acquired, expires in {}s", expiresIn);
                    return token;
                })
                .doOnError(e -> logger.error("Failed to fetch JWT token: {}", e.getMessage()));
    }

    // -------------------------------------------------------------------------
    // Discovery
    // -------------------------------------------------------------------------

    /**
     * Discover assigned transitions from master every 30 seconds.
     * Updates the set of model IDs this executor should poll for.
     */
    @Scheduled(fixedDelay = 30_000, initialDelay = 2_000)
    public void discoverAssignments() {
        webClient.get()
                .uri(uriBuilder -> uriBuilder
                        .path("/api/transitions/discover")
                        .queryParam("executorId", executorId)
                        .queryParam("allowedModels", configuredModels)
                        .build())
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<DiscoveryResponse>() {})
                .timeout(Duration.ofSeconds(10))
                .doOnNext(response -> {
                    Set<String> newModelIds = ConcurrentHashMap.newKeySet();
                    if (response.assignments() != null) {
                        response.assignments().forEach(a -> newModelIds.add(a.modelId()));
                    }
                    if (!newModelIds.equals(discoveredModelIds)) {
                        logger.info("Discovery update: models {} -> {}", discoveredModelIds, newModelIds);
                    }
                    discoveredModelIds.clear();
                    discoveredModelIds.addAll(newModelIds);
                })
                .doOnError(e -> logger.debug("Discovery failed (upstream may be unavailable): {}", e.getMessage()))
                .onErrorResume(e -> Mono.empty())
                .subscribe();
    }

    // -------------------------------------------------------------------------
    // Multi-model polling
    // -------------------------------------------------------------------------

    /**
     * Poll upstream for assigned transitions every 2 seconds, once per model.
     */
    @Scheduled(fixedDelay = 2000, initialDelay = 5000)
    public void pollForWork() {
        Set<String> models = Set.copyOf(discoveredModelIds);
        if (models.isEmpty()) {
            logger.debug("No models discovered yet, skipping poll cycle");
            return;
        }

        for (String modelId : models) {
            pollModelForWork(modelId);
        }
    }

    private void pollModelForWork(String modelId) {
        logger.debug("Polling upstream for work: executorId={}, modelId={}", executorId, modelId);

        pollMaster(modelId)
                .flatMapMany(pollResponse -> {
                    logger.debug("Received {} transitions from upstream for model {}",
                            pollResponse.transitionCount(), modelId);
                    return reactor.core.publisher.Flux.fromIterable(pollResponse.transitions());
                })
                .flatMap(cmd -> processLifecycleCommand(modelId, cmd))
                .subscribe(
                        result -> logger.debug("Processed transition: {}", result),
                        error -> logger.error("Error processing transitions for model {}: {}",
                                modelId, error.getMessage()),
                        () -> logger.debug("Finished processing poll cycle for model {}", modelId)
                );
    }

    /**
     * Poll upstream for assigned transitions for a specific model.
     */
    private Mono<PollResponse> pollMaster(String modelId) {
        List<String> deployedIds = transitionStore.listByModel(modelId).stream()
                .map(TransitionDefinition::transitionId)
                .toList();

        return webClient.get()
                .uri(uriBuilder -> {
                    var builder = uriBuilder
                            .path("/api/transitions/poll")
                            .queryParam("executorId", executorId)
                            .queryParam("modelId", modelId)
                            .queryParam("allowedModels", configuredModels);
                    if (!deployedIds.isEmpty()) {
                        builder.queryParam("deployed", deployedIds);
                    }
                    return builder.build();
                })
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<PollResponse>() {})
                .timeout(Duration.ofSeconds(5))
                .onErrorResume(error -> {
                    logger.debug("Poll failed for model {} (upstream may be unavailable): {}",
                            modelId, error.getMessage());
                    return Mono.just(new PollResponse(executorId, modelId, Instant.now(), 0, List.of()));
                });
    }

    // -------------------------------------------------------------------------
    // Lifecycle command processing
    // -------------------------------------------------------------------------

    private Mono<String> processLifecycleCommand(String modelId, TransitionWithCommand transitionCmd) {
        String transitionId = transitionCmd.transitionId();
        LifecycleCommand command = transitionCmd.command();

        if (!isCommandTransition(transitionCmd)) {
            logger.warn("⚠️ Rejecting non-command transition {}:{} - action type '{}' executes on master",
                transitionId, modelId, getActionType(transitionCmd));
            return Mono.just("rejected: " + transitionId + " (non-command transition)");
        }

        syncStatusFromMaster(modelId, transitionCmd);

        logger.info("Processing command {} for transition {}:{}", command, modelId, transitionId);

        return switch (command) {
            case DEPLOY -> deployTransition(modelId, transitionCmd);
            case START -> startTransition(modelId, transitionCmd);
            case STOP -> stopTransition(modelId, transitionId);
            case RESTART -> restartTransition(modelId, transitionCmd);
            case UPDATE -> updateTransition(modelId, transitionCmd);
            case DELETE -> deleteTransition(modelId, transitionCmd);
            case FIRE -> fireTransition(modelId, transitionCmd);
            case CONTINUE -> continueTransition(transitionId);
        };
    }

    @SuppressWarnings("unchecked")
    private boolean isCommandTransition(TransitionWithCommand transitionCmd) {
        Map<String, Object> inscription = transitionCmd.inscription();
        if (inscription == null) return false;
        Object actionObj = inscription.get("action");
        if (actionObj instanceof Map) {
            Map<String, Object> action = (Map<String, Object>) actionObj;
            return "command".equals(action.get("type"));
        }
        return false;
    }

    @SuppressWarnings("unchecked")
    private String getActionType(TransitionWithCommand transitionCmd) {
        Map<String, Object> inscription = transitionCmd.inscription();
        if (inscription == null) return "unknown";
        Object actionObj = inscription.get("action");
        if (actionObj instanceof Map) {
            String t = (String) ((Map<String, Object>) actionObj).get("type");
            if (t != null) return "action.type=" + t;
        }
        return "unknown";
    }

    private void syncStatusFromMaster(String modelId, TransitionWithCommand transitionCmd) {
        transitionStore.get(modelId, transitionCmd.transitionId()).ifPresent(def -> {
            TransitionStatus mapped = mapMasterStatus(transitionCmd.status());
            if (mapped != null && def.status() != mapped) {
                logger.info("🔄 Syncing transition {}:{} status from {} to {} (master truth)",
                        modelId, transitionCmd.transitionId(), def.status(), mapped);
                transitionStore.updateStatus(modelId, transitionCmd.transitionId(), mapped);
            }
        });
    }

    private TransitionStatus mapMasterStatus(String masterStatus) {
        if (masterStatus == null || masterStatus.isBlank()) return TransitionStatus.REGISTERED;
        return switch (masterStatus.toLowerCase()) {
            case "running" -> TransitionStatus.RUNNING;
            case "starting", "start" -> TransitionStatus.STARTING;
            case "stopped", "pause", "paused" -> TransitionStatus.STOPPED;
            case "error", "failed" -> TransitionStatus.ERROR;
            case "deployed", "undeployed", "removing", "removed" -> TransitionStatus.REGISTERED;
            default -> TransitionStatus.REGISTERED;
        };
    }

    private boolean isCommandInscription(TransitionInscription inscription) {
        return inscription != null && inscription.action() != null
                && "command".equals(inscription.action().type());
    }

    private Mono<String> deployTransition(String modelId, TransitionWithCommand transitionCmd) {
        String transitionId = transitionCmd.transitionId();
        logger.info("Deploying transition {}:{}", modelId, transitionId);

        try {
            if (transitionStore.get(modelId, transitionId).isPresent()) {
                logger.info("💡 Transition {}:{} already deployed - skipping", modelId, transitionId);
                return Mono.just("already-deployed: " + transitionId);
            }

            TransitionInscription inscription = objectMapper.convertValue(
                    transitionCmd.inscription(), TransitionInscription.class);

            if (!isCommandInscription(inscription)) {
                logger.warn("🚫 Rejecting non-command transition {}:{}", modelId, transitionId);
                return Mono.just("rejected-non-command: " + transitionId);
            }

            // Credentials arrive as plaintext from master (vault or legacy-decrypted)
            Map<String, Object> credentials = transitionCmd.credentials();
            if (credentials != null && !credentials.isEmpty()) {
                logger.info("Received {} credential keys for {}:{}",
                    credentials.size(), modelId, transitionId);
            }

            TransitionDefinition definition = TransitionDefinition.builder()
                    .modelId(modelId)
                    .transitionId(transitionId)
                    .inscription(inscription)
                    .status(TransitionStatus.REGISTERED)
                    .credentials(credentials)
                    .build();

            transitionStore.register(definition);
            logger.info("✅ Transition {}:{} deployed successfully", modelId, transitionId);

            reportDeployment(modelId, transitionId, "deployed", null).subscribe();
            return Mono.just("deployed: " + transitionId);
        } catch (Exception e) {
            logger.error("❌ Failed to deploy transition {}:{}: {}", modelId, transitionId, e.getMessage());
            reportDeployment(modelId, transitionId, "failed", e.getMessage()).subscribe();
            return Mono.error(e);
        }
    }

    private Mono<String> startTransition(String modelId, TransitionWithCommand transitionCmd) {
        String transitionId = transitionCmd.transitionId();
        logger.info("▶️ Starting transition {}:{}", modelId, transitionId);

        if (transitionStore.get(modelId, transitionId).isEmpty()) {
            if (transitionCmd.inscription() != null) {
                logger.info("💡 Transition {}:{} not deployed yet - deploying first", modelId, transitionId);
                return deployTransition(modelId, transitionCmd)
                        .flatMap(deployResult -> {
                            transitionStore.updateStatus(modelId, transitionId, TransitionStatus.RUNNING);
                            reportDeployment(modelId, transitionId, "running", null).subscribe();
                            return Mono.just("deployed-and-started: " + transitionId);
                        })
                        .onErrorResume(error -> {
                            logger.error("❌ Failed to auto-deploy {}:{}: {}", modelId, transitionId, error.getMessage());
                            return Mono.error(error);
                        });
            } else {
                logger.warn("⚠️ START but {}:{} not deployed and no inscription", modelId, transitionId);
                return Mono.just("failed: transition not deployed, no inscription");
            }
        }

        transitionStore.updateStatus(modelId, transitionId, TransitionStatus.RUNNING);
        reportDeployment(modelId, transitionId, "running", null).subscribe();
        return Mono.just("started: " + transitionId);
    }

    private Mono<String> stopTransition(String modelId, String transitionId) {
        logger.info("Stopping transition {}:{}", modelId, transitionId);
        transitionStore.get(modelId, transitionId).ifPresentOrElse(
                definition -> {
                    transitionStore.markStop(modelId, transitionId);
                    reportDeployment(modelId, transitionId, "stopped", null).subscribe();
                },
                () -> logger.warn("Transition not found: {}:{}", modelId, transitionId)
        );
        return Mono.just("stopped: " + transitionId);
    }

    private Mono<String> restartTransition(String modelId, TransitionWithCommand transitionCmd) {
        return stopTransition(modelId, transitionCmd.transitionId())
                .then(Mono.defer(() -> startTransition(modelId, transitionCmd)));
    }

    private Mono<String> updateTransition(String modelId, TransitionWithCommand transitionCmd) {
        String transitionId = transitionCmd.transitionId();
        logger.info("Updating transition {}:{}", modelId, transitionId);
        try {
            transitionStore.remove(modelId, transitionId);
            return deployTransition(modelId, transitionCmd);
        } catch (Exception e) {
            logger.error("Failed to update transition {}:{}: {}", modelId, transitionId, e.getMessage());
            return Mono.error(e);
        }
    }

    private Mono<String> deleteTransition(String modelId, TransitionWithCommand transitionCmd) {
        String transitionId = transitionCmd.transitionId();
        logger.info("🗑️ Deleting transition {}:{}", modelId, transitionId);

        return transitionStore.get(modelId, transitionId)
                .map(definition -> {
                    TransitionStatus currentStatus = definition.status();
                    if (currentStatus == TransitionStatus.STARTING || currentStatus == TransitionStatus.RUNNING) {
                        transitionStore.markStop(modelId, transitionId);
                    }
                    transitionStore.remove(modelId, transitionId);
                    reportDeployment(modelId, transitionId, "undeployed", null).subscribe();
                    return Mono.just("deleted: " + transitionId);
                })
                .orElseGet(() -> {
                    reportDeployment(modelId, transitionId, "undeployed", null).subscribe();
                    return Mono.just("deleted: " + transitionId + " (not found)");
                });
    }

    private Mono<String> continueTransition(String transitionId) {
        return Mono.just("continue: " + transitionId);
    }

    private Mono<String> fireTransition(String modelId, TransitionWithCommand transitionCmd) {
        String transitionId = transitionCmd.transitionId();
        Map<String, List<Map<String, Object>>> boundTokens = transitionCmd.boundTokens();

        logger.info("FIRE command for transition {}:{}", modelId, transitionId);

        if (!isCommandTransition(transitionCmd)) {
            return Mono.just("rejected-non-command: " + transitionId);
        }

        if (boundTokens != null && !boundTokens.isEmpty()) {
            transitionStore.get(modelId, transitionId).ifPresentOrElse(
                definition -> orchestrator.executeWithBoundTokens(modelId, transitionId, boundTokens),
                () -> logger.warn("Transition {}:{} not found for FIRE", modelId, transitionId)
            );
            return Mono.just("fire: " + transitionId + " (with " + boundTokens.size() + " preset bindings)");
        } else {
            logger.warn("FIRE with no bound tokens for {}:{}", modelId, transitionId);
            return Mono.just("fire: " + transitionId + " (no tokens bound)");
        }
    }

    // -------------------------------------------------------------------------
    // Master communication
    // -------------------------------------------------------------------------

    public Mono<Void> reportDeployment(String modelId, String transitionId, String status, String error) {
        logger.info("Reporting deployment: modelId={}, transitionId={}, status={}", modelId, transitionId, status);

        Map<String, Object> request = new HashMap<>();
        request.put("modelId", modelId);
        request.put("executorId", executorId);
        request.put("status", status);
        request.put("deployedAt", Instant.now().toString());
        if (error != null) {
            request.put("error", error);
        }

        return webClient.post()
                .uri("/api/transitions/{transitionId}/deployment", transitionId)
                .bodyValue(request)
                .retrieve()
                .bodyToMono(Void.class)
                .timeout(Duration.ofSeconds(10))
                .doOnSuccess(v -> logger.info("Deployment reported successfully"))
                .doOnError(e -> logger.error("Failed to report deployment: {}", e.getMessage()))
                .onErrorResume(err -> Mono.empty());
    }

    public Mono<Void> emitTokens(String modelId, List<TokenEmission> emissions) {
        logger.info("🔼 Emitting {} tokens via upstream for model {}", emissions.size(), modelId);

        Map<String, Object> request = new HashMap<>();
        request.put("modelId", modelId);
        request.put("emissions", emissions);

        return webClient.post()
                .uri("/api/transitions/tokens/emit")
                .bodyValue(request)
                .retrieve()
                .bodyToMono(Void.class)
                .timeout(Duration.ofSeconds(10))
                .doOnSuccess(v -> logger.info("✅ Tokens emitted successfully"))
                .doOnError(e -> logger.error("Failed to emit tokens: {}", e.getMessage()))
                .onErrorResume(err -> Mono.empty());
    }

    public Mono<Void> consumeTokens(String modelId, List<TokenReference> tokens) {
        logger.info("🗑️ Consuming {} tokens via upstream for model {}", tokens.size(), modelId);

        Map<String, Object> request = new HashMap<>();
        request.put("modelId", modelId);
        request.put("tokens", tokens);

        return webClient.post()
                .uri("/api/transitions/tokens/consume")
                .bodyValue(request)
                .retrieve()
                .bodyToMono(Void.class)
                .timeout(Duration.ofSeconds(10))
                .doOnSuccess(v -> logger.info("✅ Tokens consumed successfully"))
                .doOnError(e -> logger.error("Failed to consume tokens: {}", e.getMessage()))
                .onErrorResume(err -> Mono.empty());
    }

    // -------------------------------------------------------------------------
    // DTOs
    // -------------------------------------------------------------------------

    public static record TokenEmission(
            String placeId,
            String tokenName,
            Map<String, Object> tokenData
    ) {}

    public static record TokenReference(
            String id,
            String parentId,
            String name
    ) {}

    public static record EmissionTarget(
            String placeId,
            String host,
            List<Map<String, Object>> tokens
    ) {}

    public record PollResponse(
            String executorId,
            String modelId,
            Instant polledAt,
            int transitionCount,
            List<TransitionWithCommand> transitions
    ) {}

    public record TransitionWithCommand(
            String transitionId,
            String assignedAgent,
            String status,
            LifecycleCommand command,
            Map<String, Object> inscription,
            Instant deployedAt,
            String error,
            Map<String, Object> metrics,
            Map<String, Object> credentials,  // Plaintext credentials (from vault or legacy decrypt)
            Map<String, List<Map<String, Object>>> boundTokens,
            boolean ready
    ) {}

    public record DiscoveryResponse(
            String executorId,
            List<Assignment> assignments
    ) {}

    public record Assignment(
            String modelId,
            String transitionId
    ) {}

    public enum LifecycleCommand {
        DEPLOY, START, STOP, RESTART, UPDATE, DELETE, FIRE, CONTINUE
    }
}
