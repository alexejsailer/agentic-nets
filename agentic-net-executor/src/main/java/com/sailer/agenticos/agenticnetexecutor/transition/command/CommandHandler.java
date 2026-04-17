package com.sailer.agenticos.agenticnetexecutor.transition.command;

import java.util.List;
import java.util.Set;

/**
 * Interface for command handlers that execute specific command types.
 *
 * Implementations:
 * - FileSystemCommandHandler: readFile, writeFile, listDir, exists, mkdir, delete
 * - BashCommandHandler: exec, script
 * - KarafCommandHandler: osgiInstall, osgiStart, osgiStop, osgiList (future)
 * - McpCommandHandler: MCP tool invocation (future)
 */
public interface CommandHandler {

    /**
     * Get the executor type this handler processes (e.g., "fs", "bash", "karaf", "mcp").
     */
    String getExecutorType();

    /**
     * Get the set of supported commands for this executor.
     */
    Set<String> getSupportedCommands();

    /**
     * Check if this handler can process the given command.
     */
    default boolean canHandle(CommandToken token) {
        return getExecutorType().equals(token.executor())
                && getSupportedCommands().contains(token.command());
    }

    /**
     * Execute a single command.
     *
     * @param token The command to execute
     * @return The result of the command execution
     */
    CommandResult execute(CommandToken token);

    /**
     * Execute a batch of commands.
     * Default implementation processes commands sequentially.
     * Handlers can override for parallel or optimized batch execution.
     *
     * @param tokens The commands to execute
     * @param batchId Unique batch identifier
     * @return Batch result containing all individual results
     */
    default BatchResult executeBatch(List<CommandToken> tokens, String batchId) {
        long startTime = System.currentTimeMillis();

        List<CommandResult> results = tokens.stream()
                .map(token -> {
                    String validationError = validate(token);
                    if (validationError != null) {
                        return CommandResult.failed(token.id(), validationError, 0L, token.getMetaAsMap());
                    }
                    return execute(token);
                })
                .toList();

        long durationMs = System.currentTimeMillis() - startTime;
        return BatchResult.fromResults(getExecutorType(), batchId, results, durationMs);
    }

    /**
     * Validate a command before execution.
     * Checks if the command can be executed (e.g., path exists, permissions).
     *
     * @param token The command to validate
     * @return null if valid, error message if invalid
     */
    default String validate(CommandToken token) {
        if (!canHandle(token)) {
            return String.format("Handler '%s' cannot process executor '%s' command '%s'",
                    getExecutorType(), token.executor(), token.command());
        }
        return null; // Valid
    }

    /**
     * Get the priority of this handler (higher = preferred).
     * Used when multiple handlers could process the same executor type.
     */
    default int getPriority() {
        return 0;
    }

    /**
     * Check if this handler supports concurrent execution within a batch.
     */
    default boolean supportsConcurrentExecution() {
        return false;
    }

    /**
     * Get the maximum concurrent executions for batch processing.
     * Only relevant if supportsConcurrentExecution() returns true.
     */
    default int getMaxConcurrency() {
        return 1;
    }
}
