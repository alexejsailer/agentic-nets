package com.sailer.agenticos.agenticnetvault.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "vault")
public record VaultProperties(
    String openbaoUrl,
    String openbaoToken,
    String kvMount,
    String credentialsPath,
    AppRoleProperties approle
) {

    public record AppRoleProperties(
        String roleId,
        String secretId
    ) {
        public boolean isConfigured() {
            return roleId != null && !roleId.isBlank()
                && secretId != null && !secretId.isBlank();
        }
    }

    public String openbaoUrl() {
        return openbaoUrl != null ? openbaoUrl : "http://localhost:8200";
    }

    public String kvMount() {
        return kvMount != null ? kvMount : "secret";
    }

    public String credentialsPath() {
        return credentialsPath != null ? credentialsPath : "agenticos/credentials";
    }
}
