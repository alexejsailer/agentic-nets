package com.sailer.agenticos.agenticnetvault.service;

import com.sailer.agenticos.agenticnetvault.config.VaultProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.vault.core.VaultKeyValueOperations;
import org.springframework.vault.core.VaultKeyValueOperationsSupport;
import org.springframework.vault.core.VaultTemplate;
import org.springframework.vault.support.VaultResponse;

import java.util.Map;

@Service
public class OpenBaoClient {

    private static final Logger logger = LoggerFactory.getLogger(OpenBaoClient.class);

    private final VaultKeyValueOperations kvOps;
    private final VaultTemplate vaultTemplate;
    private final String credentialsPath;

    public OpenBaoClient(VaultTemplate vaultTemplate, VaultProperties properties) {
        this.vaultTemplate = vaultTemplate;
        this.kvOps = vaultTemplate.opsForKeyValue(
            properties.kvMount(),
            VaultKeyValueOperationsSupport.KeyValueBackend.KV_2
        );
        this.credentialsPath = properties.credentialsPath();
        logger.info("OpenBaoClient initialized — mount={}, path={}",
            properties.kvMount(), credentialsPath);
    }

    public void write(String modelId, String transitionId, Map<String, Object> credentials) {
        String path = buildPath(modelId, transitionId);
        kvOps.put(path, credentials);
        logger.info("Stored credentials at {} ({} keys)", path, credentials.size());
    }

    public VaultResponse read(String modelId, String transitionId) {
        String path = buildPath(modelId, transitionId);
        VaultResponse response = kvOps.get(path);
        if (response == null) {
            logger.debug("No credentials found at {}", path);
            return null;
        }
        return response;
    }

    public void delete(String modelId, String transitionId) {
        String path = buildPath(modelId, transitionId);
        kvOps.delete(path);
        logger.info("Deleted credentials at {}", path);
    }

    public boolean isHealthy() {
        try {
            VaultResponse response = vaultTemplate.read("sys/health");
            return response != null;
        } catch (Exception e) {
            logger.debug("OpenBao health check failed: {}", e.getMessage());
            return false;
        }
    }

    private String buildPath(String modelId, String transitionId) {
        return credentialsPath + "/" + modelId + "/" + transitionId;
    }
}
