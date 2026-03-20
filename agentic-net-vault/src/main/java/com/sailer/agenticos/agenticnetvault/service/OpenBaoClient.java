package com.sailer.agenticos.agenticnetvault.service;

import com.sailer.agenticos.agenticnetvault.config.VaultProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.vault.VaultException;
import org.springframework.vault.core.VaultKeyValueOperations;
import org.springframework.vault.core.VaultKeyValueOperationsSupport;
import org.springframework.vault.core.VaultTemplate;
import org.springframework.vault.support.VaultResponse;

import java.util.Map;
import java.util.regex.Pattern;

@Service
public class OpenBaoClient {

    private static final Logger logger = LoggerFactory.getLogger(OpenBaoClient.class);
    private static final Pattern SAFE_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]+$");
    private static final int MAX_RETRIES = 3;
    private static final long RETRY_DELAY_MS = 500;

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
        executeWithRetry(() -> {
            kvOps.put(path, credentials);
            return null;
        }, "write", path);
        logger.info("Stored credentials at {} ({} keys)", path, credentials.size());
    }

    public VaultResponse read(String modelId, String transitionId) {
        String path = buildPath(modelId, transitionId);
        try {
            VaultResponse response = executeWithRetry(() -> kvOps.get(path), "read", path);
            if (response == null) {
                logger.debug("No credentials found at {}", path);
                return null;
            }
            return response;
        } catch (VaultException e) {
            String message = e.getMessage();
            if (message != null && message.contains("404")) {
                logger.debug("No credentials found at {} (404)", path);
                return null;
            }
            throw e;
        }
    }

    public void delete(String modelId, String transitionId) {
        String path = buildPath(modelId, transitionId);
        executeWithRetry(() -> {
            kvOps.delete(path);
            return null;
        }, "delete", path);
        logger.info("Deleted credentials at {}", path);
    }

    public boolean isHealthy() {
        try {
            VaultResponse response = vaultTemplate.read("sys/health");
            return response != null;
        } catch (Exception e) {
            logger.warn("OpenBao health check failed: {}", e.getMessage());
            return false;
        }
    }

    private String buildPath(String modelId, String transitionId) {
        validatePathSegment(modelId, "modelId");
        validatePathSegment(transitionId, "transitionId");
        return credentialsPath + "/" + modelId + "/" + transitionId;
    }

    private void validatePathSegment(String value, String paramName) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(paramName + " must not be empty");
        }
        if (!SAFE_ID_PATTERN.matcher(value).matches()) {
            throw new IllegalArgumentException(
                paramName + " contains invalid characters (allowed: alphanumeric, dash, underscore)");
        }
    }

    private <T> T executeWithRetry(VaultOperation<T> operation, String operationName, String path) {
        VaultException lastException = null;
        for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                return operation.execute();
            } catch (VaultException e) {
                lastException = e;
                if (attempt < MAX_RETRIES && isTransient(e)) {
                    logger.warn("OpenBao {} failed at {} (attempt {}/{}): {}",
                        operationName, path, attempt, MAX_RETRIES, e.getMessage());
                    try {
                        Thread.sleep(RETRY_DELAY_MS * attempt);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw e;
                    }
                } else {
                    throw e;
                }
            }
        }
        throw lastException;
    }

    private boolean isTransient(VaultException e) {
        String message = e.getMessage();
        if (message == null) return false;
        return message.contains("Connection refused")
            || message.contains("connect timed out")
            || message.contains("503")
            || message.contains("429");
    }

    @FunctionalInterface
    private interface VaultOperation<T> {
        T execute();
    }
}
