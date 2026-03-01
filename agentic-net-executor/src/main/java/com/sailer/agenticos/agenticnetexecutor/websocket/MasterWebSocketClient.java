package com.sailer.agenticos.agenticnetexecutor.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStatus;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.client.ReactorNettyWebSocketClient;
import org.springframework.web.reactive.socket.client.WebSocketClient;
import reactor.core.Disposable;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.util.retry.Retry;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * WebSocket client for real-time communication with agentic-net-master.
 * Supports multi-model registration via discovery.
 */
@Service
public class MasterWebSocketClient {

    private static final Logger logger = LoggerFactory.getLogger(MasterWebSocketClient.class);
    private static final ObjectMapper objectMapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    private final WebSocketClient webSocketClient;
    private final String masterWebSocketUrl;
    private final String executorId;
    private final TransitionStore transitionStore;
    private final com.sailer.agenticos.agenticnetexecutor.transition.runtime.TransitionOrchestrator orchestrator;
    private final String communicationMode;

    private final AtomicBoolean connected = new AtomicBoolean(false);
    private final Sinks.Many<WebSocketMessage> outboundSink = Sinks.many().multicast().onBackpressureBuffer();
    private Disposable connectionDisposable;

    // Track registered model IDs
    private final Set<String> registeredModelIds = ConcurrentHashMap.newKeySet();

    public MasterWebSocketClient(
            @Value("${executor.upstream.websocket.url:ws://localhost:8082/ws/executor}") String masterWebSocketUrl,
            @Value("${executor.id:agentic-net-executor-default}") String executorId,
            @Value("${executor.communication.mode:POLLING}") String communicationMode,
            TransitionStore transitionStore,
            @Lazy com.sailer.agenticos.agenticnetexecutor.transition.runtime.TransitionOrchestrator orchestrator) {
        this.webSocketClient = new ReactorNettyWebSocketClient();
        this.masterWebSocketUrl = masterWebSocketUrl;
        this.executorId = executorId;
        this.communicationMode = communicationMode;
        this.transitionStore = transitionStore;
        this.orchestrator = orchestrator;

        logger.info("MasterWebSocketClient initialized: url={}, executorId={}, mode={}",
                masterWebSocketUrl, executorId, communicationMode);
    }

    @PostConstruct
    public void connect() {
        if ("POLLING".equalsIgnoreCase(communicationMode)) {
            logger.info("Communication mode is POLLING - WebSocket disabled");
            return;
        }
        logger.info("Connecting to master via WebSocket: {} (mode={})", masterWebSocketUrl, communicationMode);
        connectWithRetry();
    }

    @PreDestroy
    public void disconnect() {
        if (connectionDisposable != null && !connectionDisposable.isDisposed()) {
            connectionDisposable.dispose();
            logger.info("WebSocket connection closed");
        }
    }

    private void connectWithRetry() {
        connectionDisposable = webSocketClient.execute(
                URI.create(masterWebSocketUrl),
                session -> {
                    logger.info("WebSocket connected to master");
                    connected.set(true);

                    // Register for all known models
                    sendRegistration();

                    Mono<Void> incoming = session.receive()
                            .map(WebSocketMessage::getPayloadAsText)
                            .doOnNext(this::handleIncomingMessage)
                            .doOnError(error -> logger.error("WebSocket receive error: {}", error.getMessage()))
                            .doOnComplete(() -> {
                                connected.set(false);
                                logger.warn("WebSocket connection closed, will reconnect...");
                            })
                            .then();

                    Mono<Void> outgoing = session.send(outboundSink.asFlux());

                    return Mono.zip(incoming, outgoing).then();
                })
                .retryWhen(Retry.backoff(Long.MAX_VALUE, Duration.ofSeconds(5))
                        .maxBackoff(Duration.ofMinutes(1))
                        .doBeforeRetry(signal -> {
                            logger.info("Reconnecting to master (attempt {})...", signal.totalRetries() + 1);
                            connected.set(false);
                        }))
                .subscribe(
                        v -> {},
                        error -> logger.error("WebSocket connection failed permanently: {}", error.getMessage()),
                        () -> logger.info("WebSocket connection completed")
                );
    }

    /**
     * Register this executor for all models it currently serves.
     */
    private void sendRegistration() {
        Set<String> modelIds = transitionStore.modelIds();
        if (modelIds.isEmpty()) {
            // Register with no specific model (executor awaiting discovery)
            ExecutorWebSocketMessage registerMsg = ExecutorWebSocketMessage.register(executorId, List.of());
            sendMessage(registerMsg);
            logger.info("Sent registration to master: executorId={}, models=[]", executorId);
        } else {
            ExecutorWebSocketMessage registerMsg = ExecutorWebSocketMessage.register(executorId, List.copyOf(modelIds));
            sendMessage(registerMsg);
            registeredModelIds.addAll(modelIds);
            logger.info("Sent registration to master: executorId={}, models={}", executorId, modelIds);
        }
    }

    /**
     * Re-register when new models are discovered.
     */
    public void registerModels(Set<String> modelIds) {
        if (!connected.get()) return;
        Set<String> newModels = ConcurrentHashMap.newKeySet();
        newModels.addAll(modelIds);
        newModels.removeAll(registeredModelIds);
        if (!newModels.isEmpty()) {
            registeredModelIds.addAll(newModels);
            ExecutorWebSocketMessage registerMsg = ExecutorWebSocketMessage.register(executorId, List.copyOf(registeredModelIds));
            sendMessage(registerMsg);
            logger.info("Re-registered with master for models: {}", registeredModelIds);
        }
    }

    private void handleIncomingMessage(String payload) {
        try {
            ExecutorWebSocketMessage message = objectMapper.readValue(payload, ExecutorWebSocketMessage.class);
            logger.debug("Received command: {}", message.getCommand());

            if (message.getCommand() == null) {
                logger.warn("Received message without command type");
                return;
            }

            switch (message.getCommand()) {
                case DEPLOY -> handleDeploy(message);
                case START -> handleStart(message);
                case STOP -> handleStop(message);
                case FIRE -> handleFire(message);
                case DELETE -> handleDelete(message);
                case PING -> handlePing();
                default -> logger.warn("Unknown command: {}", message.getCommand());
            }
        } catch (JsonProcessingException e) {
            logger.error("Failed to parse incoming message: {}", e.getMessage());
        }
    }

    private void handleDeploy(ExecutorWebSocketMessage message) {
        String modelId = message.getModelId();
        String transitionId = message.getTransitionId();
        logger.info("DEPLOY command for transition {}:{}", modelId, transitionId);

        if (modelId == null || modelId.isBlank()) {
            logger.warn("DEPLOY command missing modelId");
            return;
        }

        try {
            if (transitionStore.get(modelId, transitionId).isPresent()) {
                logger.info("Transition {}:{} already deployed", modelId, transitionId);
                sendStatus(modelId, transitionId, "deployed", null);
                return;
            }

            TransitionInscription inscription = objectMapper.convertValue(
                    message.getInscription(), TransitionInscription.class);

            if (!isCommandInscription(inscription)) {
                logger.warn("Rejecting non-command transition {}:{}", modelId, transitionId);
                sendStatus(modelId, transitionId, "error", "Executor only accepts command transitions");
                return;
            }

            Map<String, Object> credentials = message.getCredentials();

            TransitionDefinition definition = TransitionDefinition.builder()
                    .modelId(modelId)
                    .transitionId(transitionId)
                    .inscription(inscription)
                    .status(TransitionStatus.REGISTERED)
                    .credentials(credentials)
                    .build();

            transitionStore.register(definition);
            logger.info("Transition {}:{} deployed successfully", modelId, transitionId);
            sendStatus(modelId, transitionId, "deployed", null);
        } catch (Exception e) {
            logger.error("Failed to deploy transition {}:{}: {}", modelId, transitionId, e.getMessage());
            sendStatus(modelId, transitionId, "error", e.getMessage());
        }
    }

    private void handleStart(ExecutorWebSocketMessage message) {
        String modelId = message.getModelId();
        String transitionId = message.getTransitionId();
        logger.info("START command for transition {}:{}", modelId, transitionId);

        if (transitionStore.get(modelId, transitionId).isEmpty() && message.getInscription() != null) {
            handleDeploy(message);
        }

        if (transitionStore.get(modelId, transitionId).isEmpty()) {
            sendStatus(modelId, transitionId, "error", "Transition not deployed");
            return;
        }

        transitionStore.updateStatus(modelId, transitionId, TransitionStatus.RUNNING);
        sendStatus(modelId, transitionId, "running", null);
    }

    private void handleStop(ExecutorWebSocketMessage message) {
        String modelId = message.getModelId();
        String transitionId = message.getTransitionId();

        transitionStore.get(modelId, transitionId).ifPresentOrElse(
                definition -> {
                    transitionStore.markStop(modelId, transitionId);
                    sendStatus(modelId, transitionId, "stopped", null);
                },
                () -> logger.warn("Transition {}:{} not found for STOP", modelId, transitionId)
        );
    }

    private void handleFire(ExecutorWebSocketMessage message) {
        String modelId = message.getModelId();
        String transitionId = message.getTransitionId();
        Map<String, List<Map<String, Object>>> boundTokens = message.getBoundTokens();

        if (boundTokens != null && !boundTokens.isEmpty()) {
            transitionStore.get(modelId, transitionId).ifPresentOrElse(
                    definition -> orchestrator.executeWithBoundTokens(modelId, transitionId, boundTokens),
                    () -> logger.warn("Transition {}:{} not found for FIRE", modelId, transitionId)
            );
        } else {
            logger.warn("FIRE command with no bound tokens for {}:{}", modelId, transitionId);
        }
    }

    private void handleDelete(ExecutorWebSocketMessage message) {
        String modelId = message.getModelId();
        String transitionId = message.getTransitionId();

        transitionStore.get(modelId, transitionId).ifPresentOrElse(
                definition -> {
                    if (definition.status() == TransitionStatus.RUNNING) {
                        transitionStore.markStop(modelId, transitionId);
                    }
                    transitionStore.remove(modelId, transitionId);
                    sendStatus(modelId, transitionId, "undeployed", null);
                },
                () -> {
                    logger.warn("Transition {}:{} not found for DELETE", modelId, transitionId);
                    sendStatus(modelId, transitionId, "undeployed", null);
                }
        );
    }

    private boolean isCommandInscription(TransitionInscription inscription) {
        return inscription != null
                && inscription.action() != null
                && "command".equals(inscription.action().type());
    }

    private void handlePing() {
        logger.debug("Received PING, sending PONG");
        ExecutorWebSocketMessage pong = ExecutorWebSocketMessage.pong(executorId);
        sendMessage(pong);
    }

    public void sendStatus(String modelId, String transitionId, String status, String error) {
        ExecutorWebSocketMessage statusMsg = ExecutorWebSocketMessage.status(
                executorId, modelId, transitionId, status, Instant.now(), error
        );
        sendMessage(statusMsg);
    }

    private void sendMessage(ExecutorWebSocketMessage message) {
        try {
            String json = objectMapper.writeValueAsString(message);
            logger.debug("Sending message: {}", json);
        } catch (JsonProcessingException e) {
            logger.error("Failed to serialize message: {}", e.getMessage());
        }
    }

    public boolean isConnected() {
        return connected.get();
    }
}
