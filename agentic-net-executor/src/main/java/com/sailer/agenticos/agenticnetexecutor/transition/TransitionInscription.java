package com.sailer.agenticos.agenticnetexecutor.transition;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable representation of a transition inscription definition that is loaded from JSON.
 * The inscription combines logical bindings (presets/postsets), actions, emission routing, and
 * optional idempotency metadata.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TransitionInscription(
        String id,
        String kind,
        Map<String, Preset> presets,
        Map<String, Postset> postsets,
        Action action,
        List<Emit> emit,
        Idempotency idempotency,
        TransitionMode mode,
        Integer concurrency,
        Map<String, Object> metadata
) {

    private static final Idempotency DEFAULT_IDEMPOTENCY = new Idempotency(null, null, null);

    @JsonCreator
    public TransitionInscription(
            @JsonProperty("id") String id,
            @JsonProperty("kind") String kind,
            @JsonProperty("presets") Map<String, Preset> presets,
            @JsonProperty("postsets") Map<String, Postset> postsets,
            @JsonProperty("action") Action action,
            @JsonProperty("emit") List<Emit> emit,
            @JsonProperty("idempotency") Idempotency idempotency,
            @JsonProperty("mode") TransitionMode mode,
            @JsonProperty("concurrency") Integer concurrency,
            @JsonProperty("metadata") Map<String, Object> metadata
    ) {
        this.id = Objects.requireNonNull(id, "transition id must not be null");
        this.kind = kind != null ? kind : "task";
        this.presets = presets == null ? Map.of() : copyLinkedMap(presets);
        this.postsets = postsets == null ? Map.of() : copyLinkedMap(postsets);
        this.action = Objects.requireNonNull(action, "action must not be null");
        this.emit = emit == null ? List.of() : List.copyOf(emit);
        this.idempotency = idempotency == null ? DEFAULT_IDEMPOTENCY : idempotency;
        this.mode = mode == null ? TransitionMode.SINGLE : mode;
        this.concurrency = concurrency;
        this.metadata = metadata == null ? Map.of() : Map.copyOf(metadata);

        // Command transitions may omit presets/postsets for executor-only execution.
    }

    public boolean isForeach() {
        return mode == TransitionMode.FOREACH;
    }

    private static <T> Map<String, T> copyLinkedMap(Map<String, T> source) {
        Map<String, T> copy = new LinkedHashMap<>(source.size());
        source.forEach((k, v) -> {
            if (k == null || k.isBlank()) {
                throw new IllegalArgumentException("Map keys must not be null or blank");
            }
            copy.put(k, v);
        });
        return Collections.unmodifiableMap(copy);
    }

    // ======== nested PoJo definitions ========

    /**
     * Preset binding definition describing how tokens are selected and consumed from a place.
     *
     * <p>When {@code optional=true}, the transition can fire even if no tokens match the ArcQL query.
     * This enables "negative arc" patterns where the presence of tokens is checked but not required.
     * Optional presets that find no matching tokens will bind to an empty list in the context.</p>
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Preset(
            String placeId,
            String host,
            String arcql,
            Take take,
            Boolean consume,
            Integer limit,
            Long reservationTtlMs,
            Long pollIntervalMs,
            Boolean optional,
            Map<String, Object> extensions
    ) {
        @JsonCreator
        public Preset(
                @JsonProperty("placeId") String placeId,
                @JsonProperty("host") String host,
                @JsonProperty("arcql") String arcql,
                @JsonProperty("take") Take take,
                @JsonProperty("consume") Boolean consume,
                @JsonProperty("limit") Integer limit,
                @JsonProperty("reservationTtlMs") Long reservationTtlMs,
                @JsonProperty("pollIntervalMs") Long pollIntervalMs,
                @JsonProperty("optional") Boolean optional,
                @JsonProperty("extensions") Map<String, Object> extensions
        ) {
            this.placeId = Objects.requireNonNull(placeId, "Preset placeId must not be null");
            this.host = Objects.requireNonNull(host, "Preset host must not be null");
            this.arcql = Objects.requireNonNull(arcql, "Preset arcql must not be null");
            this.take = take == null ? Take.FIRST : take;
            this.consume = consume == null || consume;
            this.limit = limit;
            this.reservationTtlMs = reservationTtlMs;
            this.pollIntervalMs = pollIntervalMs;
            this.optional = optional != null && optional;  // Default to false (required)
            this.extensions = extensions == null ? Map.of() : Map.copyOf(extensions);
        }

        /**
         * Returns true if this preset is optional (transition can fire without matching tokens).
         */
        public boolean isOptional() {
            return optional != null && optional;
        }

        public int resolveLimit() {
            if (limit != null) {
                return limit;
            }
            return switch (take) {
                case FIRST -> 1;
                case ALL -> Integer.MAX_VALUE;
                case LIMIT -> 1; // default fallback
            };
        }
    }

    /**
     * Cardinality semantics for presets.
     */
    public enum Take {
        FIRST,
        ALL,
        LIMIT;

        public static Take fromString(String value) {
            if (value == null || value.isBlank()) {
                return FIRST;
            }
            return switch (value.toLowerCase()) {
                case "first" -> FIRST;
                case "all" -> ALL;
                case "limit" -> LIMIT;
                default -> FIRST;
            };
        }
    }

    /**
     * Postset definition describing target place metadata.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Postset(
            String placeId,
            String host,
            String description,
            Integer capacity,
            Map<String, Object> extensions
    ) {
        @JsonCreator
        public Postset(
                @JsonProperty("placeId") String placeId,
                @JsonProperty("host") String host,
                @JsonProperty("description") String description,
                @JsonProperty("capacity") Integer capacity,
                @JsonProperty("extensions") Map<String, Object> extensions
        ) {
            this.placeId = Objects.requireNonNull(placeId, "Postset placeId must not be null");
            this.host = Objects.requireNonNull(host, "Postset host must not be null");
            this.description = description;
            this.capacity = capacity;  // null means unlimited capacity
            this.extensions = extensions == null ? Map.of() : Map.copyOf(extensions);
        }

        /**
         * Returns true if this postset has a capacity constraint.
         */
        public boolean hasCapacity() {
            return capacity != null && capacity > 0;
        }
    }

    /**
     * Emit rule describing how payloads are routed to postsets.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Emit(
            String to,
            String from,
            String payload,
            String when,
            Map<String, Object> extensions
    ) {
        @JsonCreator
        public Emit(
                @JsonProperty("to") String to,
                @JsonProperty("from") String from,
                @JsonProperty("payload") String payload,
                @JsonProperty("when") String when,
                @JsonProperty("extensions") Map<String, Object> extensions
        ) {
            this.to = Objects.requireNonNull(to, "Emit target must not be null");
            this.from = from;
            this.payload = payload;
            this.when = when;
            this.extensions = extensions == null ? Map.of() : Map.copyOf(extensions);
        }

        public boolean appliesOn(String phase) {
            if (when == null || when.isBlank()) {
                // No condition = catch-all, matches any phase (success, error, etc.)
                return true;
            }
            return when.equalsIgnoreCase(phase);
        }

    }

    /**
     * Idempotency metadata for transition executions.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Idempotency(String key, String header, Long ttlMs) {
        public boolean enabled() {
            return key != null && !key.isBlank();
        }
    }

    /**
     * Command-only action type hierarchy for executor transitions.
     */
    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
    @JsonSubTypes({
            @JsonSubTypes.Type(value = Action.CommandAction.class, name = "command")
    })
    public sealed interface Action permits Action.CommandAction {
        String type();

        /**
         * Command Action - Bridge to remote executors for environment-specific operations.
         * Command tokens are grouped by executor type and dispatched to local handlers.
         */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record CommandAction(
                String inputPlace,           // Place containing command tokens
                String groupBy,              // Field to group by (typically "executor")
                BatchingConfig batching,     // Batching configuration
                List<CommandExecutorRoute> dispatch,  // Executor routing table
                AwaitMode await,             // ALL, NONE, FIRST
                Long timeoutMs               // Execution timeout
        ) implements Action {
            @JsonCreator
            public CommandAction(
                    @JsonProperty("inputPlace") String inputPlace,
                    @JsonProperty("groupBy") String groupBy,
                    @JsonProperty("batching") BatchingConfig batching,
                    @JsonProperty("dispatch") List<CommandExecutorRoute> dispatch,
                    @JsonProperty("await") AwaitMode await,
                    @JsonProperty("timeoutMs") Long timeoutMs
            ) {
                this.inputPlace = Objects.requireNonNull(inputPlace, "inputPlace required for command action");
                this.groupBy = groupBy != null ? groupBy : "executor";
                this.batching = batching != null ? batching : BatchingConfig.defaults();
                this.dispatch = dispatch != null ? List.copyOf(dispatch) : List.of();
                this.await = await != null ? await : AwaitMode.ALL;
                this.timeoutMs = timeoutMs != null ? timeoutMs : 60000L;
            }

            @Override
            public String type() {
                return "command";
            }
        }

        /**
         * Batching configuration for command execution.
         */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record BatchingConfig(String mode, Integer maxBatchSize) {
            @JsonCreator
            public BatchingConfig(
                    @JsonProperty("mode") String mode,
                    @JsonProperty("maxBatchSize") Integer maxBatchSize
            ) {
                this.mode = mode != null ? mode : "PER_EXECUTOR";
                this.maxBatchSize = maxBatchSize != null ? maxBatchSize : 50;
            }

            static BatchingConfig defaults() {
                return new BatchingConfig("PER_EXECUTOR", 50);
            }
        }

        /**
         * Routing entry mapping executor type to channel.
         */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record CommandExecutorRoute(String executor, String channel) {
            @JsonCreator
            public CommandExecutorRoute(
                    @JsonProperty("executor") String executor,
                    @JsonProperty("channel") String channel
            ) {
                this.executor = Objects.requireNonNull(executor, "executor required in dispatch route");
                this.channel = channel != null ? channel : "default";
            }
        }

        /**
         * Await mode for command execution.
         */
        enum AwaitMode { ALL, NONE, FIRST }
    }
}
