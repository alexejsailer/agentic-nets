package com.sailer.agenticos.agenticnetexecutor.transition.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import java.util.stream.StreamSupport;

public record ArcQueryResult(List<TokenBinding> results) {

    private static final Logger logger = LoggerFactory.getLogger(ArcQueryResult.class);

    public static ArcQueryResult empty() {
        return new ArcQueryResult(List.of());
    }

    public boolean isEmpty() {
        return results == null || results.isEmpty();
    }

    public static ArcQueryResult fromJson(JsonNode node, ObjectMapper mapper) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return empty();
        }
        if (!node.isArray()) {
            logger.warn("ArcQL response results not an array: {}", node);
            return empty();
        }
        ArrayNode array = (ArrayNode) node;
        List<TokenBinding> entries = StreamSupport.stream(array.spliterator(), false)
                .map(item -> toTokenBinding(item, mapper))
                .filter(Objects::nonNull)
                .collect(Collectors.toList());
        return new ArcQueryResult(entries);
    }

    private static TokenBinding toTokenBinding(JsonNode node, ObjectMapper mapper) {
        if (node == null || node.isNull()) {
            return null;
        }
        JsonNode metaNode = node.path("_meta");
        if (metaNode == null || metaNode.isMissingNode()) {
            logger.debug("ArcQL result missing _meta node: {}", node);
            return null;
        }
        String id = metaNode.path("id").asText(null);
        String name = metaNode.path("name").asText(null);
        String parentId = metaNode.path("parentId").asText(null);
        String type = metaNode.path("type").asText(null);
        Map<String, String> properties = Collections.emptyMap();
        JsonNode lockNode = null;
        if (metaNode.path("properties").isObject()) {
            properties = mapper.convertValue(metaNode.path("properties"), mapper.getTypeFactory().constructMapType(Map.class, String.class, String.class));
            String rawLock = properties.get("_lock");
            if (rawLock != null) {
                try {
                    lockNode = mapper.readTree(rawLock);
                } catch (Exception e) {
                    logger.debug("Failed to parse lock payload: {}", rawLock, e);
                }
            }
        }
        JsonNode data = node.path("data");
        // If data is missing or null, create empty object to prevent emission skip
        if (data == null || data.isMissingNode() || data.isNull()) {
            data = mapper.createObjectNode();  // Empty {} instead of null
        }
        return new TokenBinding(id, name, parentId, type, properties, data, lockNode);
    }

    public record TokenBinding(String id,
                               String name,
                               String parentId,
                               String type,
                               Map<String, String> properties,
                               JsonNode data,
                               JsonNode lock) {
        public boolean hasLock() {
            return lock != null && !lock.isMissingNode();
        }

        public String lockOwner() {
            return hasLock() ? lock.path("owner").asText(null) : null;
        }

        public long lockExpiryEpochMs() {
            return hasLock() ? lock.path("expiresAt").asLong(0L) : 0L;
        }
    }
}
