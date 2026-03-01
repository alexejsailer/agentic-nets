package com.sailer.agenticos.agenticnetvault.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.vault.support.VaultResponse;

import java.time.Instant;
import java.util.*;

@Service
public class CredentialService {

    private static final Logger logger = LoggerFactory.getLogger(CredentialService.class);

    private final OpenBaoClient openBaoClient;

    public CredentialService(OpenBaoClient openBaoClient) {
        this.openBaoClient = openBaoClient;
    }

    public Map<String, Object> storeCredentials(String modelId, String transitionId,
                                                  Map<String, Object> credentials) {
        openBaoClient.write(modelId, transitionId, credentials);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", modelId);
        result.put("transitionId", transitionId);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("keyNames", new ArrayList<>(credentials.keySet()));
        metadata.put("updatedAt", Instant.now().toString());
        result.put("metadata", metadata);

        // Read back to get version from OpenBao
        try {
            VaultResponse response = openBaoClient.read(modelId, transitionId);
            if (response != null && response.getMetadata() != null) {
                Object version = response.getMetadata().get("version");
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
        VaultResponse response = openBaoClient.read(modelId, transitionId);
        if (response == null || response.getData() == null) {
            return null;
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", modelId);
        result.put("transitionId", transitionId);
        result.put("credentials", response.getData());

        Map<String, Object> metadata = buildMetadata(response);
        result.put("metadata", metadata);

        return result;
    }

    public Map<String, Object> readMetadata(String modelId, String transitionId) {
        VaultResponse response = openBaoClient.read(modelId, transitionId);
        if (response == null || response.getData() == null) {
            return null;
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", modelId);
        result.put("transitionId", transitionId);

        Map<String, Object> metadata = buildMetadata(response);
        result.put("metadata", metadata);

        return result;
    }

    public void deleteCredentials(String modelId, String transitionId) {
        openBaoClient.delete(modelId, transitionId);
    }

    private Map<String, Object> buildMetadata(VaultResponse response) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        if (response.getData() != null) {
            metadata.put("keyNames", new ArrayList<>(response.getData().keySet()));
        }
        if (response.getMetadata() != null) {
            Map<String, Object> vaultMeta = response.getMetadata();
            if (vaultMeta.containsKey("version")) {
                metadata.put("version", vaultMeta.get("version"));
            }
            if (vaultMeta.containsKey("created_time")) {
                metadata.put("createdAt", vaultMeta.get("created_time"));
            }
            if (vaultMeta.containsKey("deletion_time")) {
                String deletionTime = String.valueOf(vaultMeta.get("deletion_time"));
                if (!deletionTime.isEmpty() && !deletionTime.equals("")) {
                    metadata.put("deletedAt", deletionTime);
                }
            }
        }
        return metadata;
    }
}
