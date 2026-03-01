package com.sailer.agenticos.agenticnetexecutor.websocket;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * WebSocket message protocol for executor-master communication.
 * Mirror of the master's ExecutorWebSocketMessage for deserialization.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ExecutorWebSocketMessage {

    public enum CommandType {
        DEPLOY, START, STOP, RESTART, UPDATE, DELETE, FIRE, PING
    }

    public enum StatusType {
        REGISTER, STATUS, METRICS, PONG, ACK
    }

    private String messageId;
    private Instant timestamp;
    private CommandType command;
    private String transitionId;
    private Map<String, Object> inscription;
    private Map<String, List<Map<String, Object>>> boundTokens;
    private Map<String, Object> credentials;
    private boolean ready;
    private StatusType statusType;
    private String executorId;
    private String modelId;
    private List<String> modelIds;    // Multi-model registration
    private String status;
    private Instant deployedAt;
    private String error;
    private Map<String, Object> metrics;

    public ExecutorWebSocketMessage() {
        this.timestamp = Instant.now();
    }

    // Factory methods for executor -> master messages
    public static ExecutorWebSocketMessage register(String executorId, List<String> modelIds) {
        ExecutorWebSocketMessage msg = new ExecutorWebSocketMessage();
        msg.messageId = java.util.UUID.randomUUID().toString();
        msg.statusType = StatusType.REGISTER;
        msg.executorId = executorId;
        msg.modelIds = modelIds;
        return msg;
    }

    public static ExecutorWebSocketMessage status(String executorId, String modelId,
                                                   String transitionId, String status,
                                                   Instant deployedAt, String error) {
        ExecutorWebSocketMessage msg = new ExecutorWebSocketMessage();
        msg.messageId = java.util.UUID.randomUUID().toString();
        msg.statusType = StatusType.STATUS;
        msg.executorId = executorId;
        msg.modelId = modelId;
        msg.transitionId = transitionId;
        msg.status = status;
        msg.deployedAt = deployedAt;
        msg.error = error;
        return msg;
    }

    public static ExecutorWebSocketMessage pong(String executorId) {
        ExecutorWebSocketMessage msg = new ExecutorWebSocketMessage();
        msg.messageId = java.util.UUID.randomUUID().toString();
        msg.statusType = StatusType.PONG;
        msg.executorId = executorId;
        return msg;
    }

    // Getters and setters
    public String getMessageId() { return messageId; }
    public void setMessageId(String messageId) { this.messageId = messageId; }

    public Instant getTimestamp() { return timestamp; }
    public void setTimestamp(Instant timestamp) { this.timestamp = timestamp; }

    public CommandType getCommand() { return command; }
    public void setCommand(CommandType command) { this.command = command; }

    public String getTransitionId() { return transitionId; }
    public void setTransitionId(String transitionId) { this.transitionId = transitionId; }

    public Map<String, Object> getInscription() { return inscription; }
    public void setInscription(Map<String, Object> inscription) { this.inscription = inscription; }

    public Map<String, List<Map<String, Object>>> getBoundTokens() { return boundTokens; }
    public void setBoundTokens(Map<String, List<Map<String, Object>>> boundTokens) { this.boundTokens = boundTokens; }

    public Map<String, Object> getCredentials() { return credentials; }
    public void setCredentials(Map<String, Object> credentials) { this.credentials = credentials; }

    public boolean isReady() { return ready; }
    public void setReady(boolean ready) { this.ready = ready; }

    public StatusType getStatusType() { return statusType; }
    public void setStatusType(StatusType statusType) { this.statusType = statusType; }

    public String getExecutorId() { return executorId; }
    public void setExecutorId(String executorId) { this.executorId = executorId; }

    public String getModelId() { return modelId; }
    public void setModelId(String modelId) { this.modelId = modelId; }

    public List<String> getModelIds() { return modelIds; }
    public void setModelIds(List<String> modelIds) { this.modelIds = modelIds; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public Instant getDeployedAt() { return deployedAt; }
    public void setDeployedAt(Instant deployedAt) { this.deployedAt = deployedAt; }

    public String getError() { return error; }
    public void setError(String error) { this.error = error; }

    public Map<String, Object> getMetrics() { return metrics; }
    public void setMetrics(Map<String, Object> metrics) { this.metrics = metrics; }

}
