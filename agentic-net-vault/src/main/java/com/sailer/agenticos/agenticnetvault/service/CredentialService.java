package com.sailer.agenticos.agenticnetvault.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

@Service
public class CredentialService {

    private static final Logger logger = LoggerFactory.getLogger(CredentialService.class);

    private final CredentialStore store;

    public CredentialService(CredentialStore store) {
        this.store = store;
    }

    public Map<String, Object> storeCredentials(String modelId, String transitionId,
                                                  Map<String, Object> credentials) {
        store.write(modelId, transitionId, credentials);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", modelId);
        result.put("transitionId", transitionId);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("keyNames", new ArrayList<>(credentials.keySet()));
        metadata.put("updatedAt", Instant.now().toString());
        result.put("metadata", metadata);

        // Read back to get the backend-assigned version
        try {
            StoredCredentials stored = store.read(modelId, transitionId);
            if (stored != null && stored.metadata() != null) {
                Object version = stored.metadata().get("version");
                if (version != null) {
                    metadata.put("version", version);
                }
            }
        } catch (Exception e) {
            logger.debug("Could not read back metadata after write: {}", e.getMessage());
        }

        return result;
    }

    public Map<String, Object> readCredentials(String modelId, String transitionId) {
        StoredCredentials stored = store.read(modelId, transitionId);
        if (stored == null || stored.data() == null) {
            return null;
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", modelId);
        result.put("transitionId", transitionId);
        result.put("credentials", stored.data());

        Map<String, Object> metadata = buildMetadata(stored);
        result.put("metadata", metadata);

        return result;
    }

    public Map<String, Object> readMetadata(String modelId, String transitionId) {
        StoredCredentials stored = store.read(modelId, transitionId);
        if (stored == null || stored.data() == null) {
            return null;
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", modelId);
        result.put("transitionId", transitionId);

        Map<String, Object> metadata = buildMetadata(stored);
        result.put("metadata", metadata);

        return result;
    }

    public void deleteCredentials(String modelId, String transitionId) {
        store.delete(modelId, transitionId);
    }

    private Map<String, Object> buildMetadata(StoredCredentials stored) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        if (stored.data() != null) {
            metadata.put("keyNames", new ArrayList<>(stored.data().keySet()));
        }
        if (stored.metadata() != null) {
            Map<String, Object> backendMeta = stored.metadata();
            if (backendMeta.containsKey("version")) {
                metadata.put("version", backendMeta.get("version"));
            }
            if (backendMeta.containsKey("created_time")) {
                metadata.put("createdAt", backendMeta.get("created_time"));
            }
            if (backendMeta.containsKey("deletion_time")) {
                String deletionTime = String.valueOf(backendMeta.get("deletion_time"));
                if (!deletionTime.isEmpty() && !deletionTime.equals("")) {
                    metadata.put("deletedAt", deletionTime);
                }
            }
        }
        return metadata;
    }
}
