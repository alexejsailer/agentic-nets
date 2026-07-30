package com.sailer.agenticos.agenticnetvault.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "vault")
public record VaultProperties(
    String backend,
    String openbaoUrl,
    String openbaoToken,
    String kvMount,
    String credentialsPath,
    AppRoleProperties approle,
    FileStoreProperties file
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

    /** Settings for the self-contained encrypted file backend (vault.backend=file). */
    public record FileStoreProperties(
        String path,
        String keyFile
    ) {
        public String path() {
            return path != null && !path.isBlank()
                ? path
                : System.getProperty("user.home") + "/.agenticos/vault/credentials";
        }

        public String keyFile() {
            return keyFile != null && !keyFile.isBlank()
                ? keyFile
                : System.getProperty("user.home") + "/.agenticos/vault/vault.key";
        }
    }

    public String backend() {
        return backend != null && !backend.isBlank() ? backend : "openbao";
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

    public FileStoreProperties file() {
        return file != null ? file : new FileStoreProperties(null, null);
    }
}
