package com.sailer.agenticos.agenticnetvault.service;

import java.util.Map;

/**
 * Storage backend for transition credentials. Selected via {@code vault.backend}
 * ({@code VAULT_BACKEND}): {@code openbao} (default) or {@code file}.
 */
public interface CredentialStore {

    void write(String modelId, String transitionId, Map<String, Object> credentials);

    /** Returns the stored credentials, or {@code null} when none exist. */
    StoredCredentials read(String modelId, String transitionId);

    void delete(String modelId, String transitionId);

    boolean isHealthy();

    String backendName();
}
