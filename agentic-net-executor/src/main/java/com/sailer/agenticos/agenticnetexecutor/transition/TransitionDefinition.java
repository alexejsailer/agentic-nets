package com.sailer.agenticos.agenticnetexecutor.transition;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Runtime wrapper around a transition inscription adding lifecycle state and metadata.
 */
public final class TransitionDefinition {

    private final String modelId;
    private final String transitionId;
    private final TransitionInscription inscription;
    private final Instant createdAt;
    private volatile Instant updatedAt;
    private volatile TransitionStatus status;
    private volatile String lastError;
    private final TransitionMetrics metrics;
    private final Map<String, String> tags;
    private final Map<String, Object> credentials;  // Decrypted credentials ready for template interpolation

    private TransitionDefinition(Builder builder) {
        this.modelId = Objects.requireNonNull(builder.modelId, "modelId");
        this.transitionId = Objects.requireNonNull(builder.transitionId, "transitionId");
        this.inscription = Objects.requireNonNull(builder.inscription, "inscription");
        this.createdAt = builder.createdAt != null ? builder.createdAt : Instant.now();
        this.updatedAt = builder.updatedAt != null ? builder.updatedAt : this.createdAt;
        this.status = builder.status != null ? builder.status : TransitionStatus.REGISTERED;
        this.lastError = builder.lastError;
        this.metrics = builder.metrics != null ? builder.metrics : new TransitionMetrics();
        this.tags = builder.tags != null ? Map.copyOf(builder.tags) : Map.of();
        this.credentials = builder.credentials;
    }

    public static Builder builder() {
        return new Builder();
    }

    public String modelId() {
        return modelId;
    }

    public String transitionId() {
        return transitionId;
    }

    public TransitionInscription inscription() {
        return inscription;
    }

    public TransitionStatus status() {
        return status;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant updatedAt() {
        return updatedAt;
    }

    public Optional<String> lastError() {
        return Optional.ofNullable(lastError);
    }

    public TransitionMetrics metrics() {
        return metrics;
    }

    public Map<String, String> tags() {
        return tags;
    }

    public Map<String, Object> credentials() {
        return credentials;
    }

    public void markStatus(TransitionStatus newStatus) {
        this.status = Objects.requireNonNull(newStatus, "status");
        this.updatedAt = Instant.now();
    }

    public void recordError(String error) {
        this.lastError = error;
        this.updatedAt = Instant.now();
    }

    public void clearError() {
        this.lastError = null;
        this.updatedAt = Instant.now();
    }

    public static final class Builder {
        private String modelId;
        private String transitionId;
        private TransitionInscription inscription;
        private Instant createdAt;
        private Instant updatedAt;
        private TransitionStatus status;
        private String lastError;
        private TransitionMetrics metrics;
        private Map<String, String> tags;
        private Map<String, Object> credentials;

        private Builder() {
        }

        public Builder modelId(String modelId) {
            this.modelId = modelId;
            return this;
        }

        public Builder transitionId(String transitionId) {
            this.transitionId = transitionId;
            return this;
        }

        public Builder inscription(TransitionInscription inscription) {
            this.inscription = inscription;
            return this;
        }

        public Builder createdAt(Instant createdAt) {
            this.createdAt = createdAt;
            return this;
        }

        public Builder updatedAt(Instant updatedAt) {
            this.updatedAt = updatedAt;
            return this;
        }

        public Builder status(TransitionStatus status) {
            this.status = status;
            return this;
        }

        public Builder lastError(String lastError) {
            this.lastError = lastError;
            return this;
        }

        public Builder metrics(TransitionMetrics metrics) {
            this.metrics = metrics;
            return this;
        }

        public Builder tags(Map<String, String> tags) {
            this.tags = tags;
            return this;
        }

        public Builder credentials(Map<String, Object> credentials) {
            this.credentials = credentials;
            return this;
        }

        public TransitionDefinition build() {
            return new TransitionDefinition(this);
        }
    }
}
