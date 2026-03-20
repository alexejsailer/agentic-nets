package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Dispatcher that routes command tokens to appropriate handlers.
 *
 * Responsibilities:
 * - Parse command tokens from JSON
 * - Route to correct handler based on executor type
 * - Support batching by executor type
 * - Handle concurrent execution where supported
 */
@Service
public class CommandExecutorDispatcher {

    private static final Logger logger = LoggerFactory.getLogger(CommandExecutorDispatcher.class);

    private final Map<String, CommandHandler> handlerMap;
    private final ObjectMapper objectMapper;
    private final ExecutorService executorService;

    public CommandExecutorDispatcher(List<CommandHandler> handlers, ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.executorService = Executors.newFixedThreadPool(
                Runtime.getRuntime().availableProcessors()
        );

        // Build handler map, prefer higher priority handlers
        this.handlerMap = handlers.stream()
                .sorted(Comparator.comparingInt(CommandHandler::getPriority).reversed())
                .collect(Collectors.toMap(
                        CommandHandler::getExecutorType,
                        h -> h,
                        (existing, replacement) -> existing  // Keep first (higher priority)
                ));

        logger.info("CommandExecutorDispatcher initialized with handlers: {}", handlerMap.keySet());
    }

    /**
     * Get the set of supported executor types.
     */
    public Set<String> getSupportedExecutors() {
        return Collections.unmodifiableSet(handlerMap.keySet());
    }

    /**
     * Check if an executor type is supported.
     */
    public boolean supportsExecutor(String executor) {
        return handlerMap.containsKey(executor);
    }

    /**
     * Execute a single command token.
     */
    public CommandResult executeCommand(CommandToken token) {
        CommandHandler handler = handlerMap.get(token.executor());

        if (handler == null) {
            logger.warn("No handler found for executor: {}", token.executor());
            return CommandResult.failed(
                    token.id(),
                    "No handler for executor: " + token.executor(),
                    0L,
                    token.getMetaAsMap()
            );
        }

        // Validate before execution
        String validationError = handler.validate(token);
        if (validationError != null) {
            return CommandResult.failed(token.id(), validationError, 0L, token.getMetaAsMap());
        }

        return handler.execute(token);
    }

    /**
     * Execute a batch of commands, grouped by executor type.
     */
    public List<BatchResult> executeBatch(List<CommandToken> tokens, String batchPrefix) {
        if (tokens.isEmpty()) {
            return List.of();
        }

        // Group tokens by executor
        Map<String, List<CommandToken>> byExecutor = tokens.stream()
                .collect(Collectors.groupingBy(CommandToken::executor));

        List<BatchResult> results = new ArrayList<>();

        for (Map.Entry<String, List<CommandToken>> entry : byExecutor.entrySet()) {
            String executor = entry.getKey();
            List<CommandToken> executorTokens = entry.getValue();
            String batchId = batchPrefix + "-" + executor;

            CommandHandler handler = handlerMap.get(executor);

            if (handler == null) {
                // Create failed results for all tokens without handler
                List<CommandResult> failedResults = executorTokens.stream()
                        .map(t -> CommandResult.failed(
                                t.id(),
                                "No handler for executor: " + executor,
                                0L,
                                t.getMetaAsMap()
                        ))
                        .toList();
                results.add(BatchResult.fromResults(executor, batchId, failedResults, 0L));
                continue;
            }

            BatchResult batchResult = handler.executeBatch(executorTokens, batchId);
            results.add(batchResult);
        }

        return results;
    }

    /**
     * Execute commands in parallel where supported.
     */
    public CompletableFuture<List<CommandResult>> executeParallel(List<CommandToken> tokens) {
        if (tokens.isEmpty()) {
            return CompletableFuture.completedFuture(List.of());
        }

        List<CompletableFuture<CommandResult>> futures = tokens.stream()
                .map(token -> CompletableFuture.supplyAsync(
                        () -> executeCommand(token),
                        executorService
                ))
                .toList();

        return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
                .thenApply(v -> futures.stream()
                        .map(CompletableFuture::join)
                        .toList());
    }

    /**
     * Parse a command token from JSON.
     */
    public CommandToken parseToken(JsonNode json) {
        try {
            return objectMapper.treeToValue(json, CommandToken.class);
        } catch (Exception e) {
            logger.error("Failed to parse command token: {}", e.getMessage());
            throw new IllegalArgumentException("Invalid command token JSON: " + e.getMessage(), e);
        }
    }

    /**
     * Parse multiple command tokens from a JSON array.
     */
    public List<CommandToken> parseTokens(JsonNode jsonArray) {
        if (!jsonArray.isArray()) {
            throw new IllegalArgumentException("Expected JSON array for command tokens");
        }

        List<CommandToken> tokens = new ArrayList<>();
        for (JsonNode node : jsonArray) {
            tokens.add(parseToken(node));
        }
        return tokens;
    }

    /**
     * Validate a command token without executing.
     */
    public String validateToken(CommandToken token) {
        if (!token.isValid()) {
            return "Invalid command token: missing required fields";
        }

        CommandHandler handler = handlerMap.get(token.executor());
        if (handler == null) {
            return "No handler for executor: " + token.executor();
        }

        return handler.validate(token);
    }

    /**
     * Get handler for a specific executor type.
     */
    public Optional<CommandHandler> getHandler(String executor) {
        return Optional.ofNullable(handlerMap.get(executor));
    }

    /**
     * Shutdown the executor service.
     */
    public void shutdown() {
        executorService.shutdown();
        try {
            if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
                logger.warn("ExecutorService did not terminate within 30s, forcing shutdown");
                executorService.shutdownNow();
                if (!executorService.awaitTermination(10, TimeUnit.SECONDS)) {
                    logger.error("ExecutorService did not terminate after shutdownNow");
                }
            }
        } catch (InterruptedException e) {
            executorService.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
