package com.sailer.agenticos.agenticnetgateway.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Gateway configuration properties.
 */
@Component
@ConfigurationProperties(prefix = "gateway")
public class GatewayProperties {

    private String masterUrl = "http://localhost:8082";
    private String nodeUrl = "http://localhost:8080";
    private String vaultUrl = "http://localhost:8085";
    private int timeoutSeconds = 30;
    private int proxyTimeoutSeconds = 300;
    private String clientId = "agenticos-admin";
    private String clientSecret = "";
    private String readonlyClientId = "agenticos-readonly";
    private String readonlyClientSecret = "";
    private String executorClientId = "agenticos-executor";
    private String executorClientSecret = "";
    private String jwtKeyDir = "./data/jwt";
    private int tokenTtlSeconds = 3600;
    private int rateLimitPerMinute = 10;
    private String trustedProxies = "";
    private String internalSecret = "";
    private int masterHeartbeatTtlSeconds = 60;
    private int proxyFanOutTimeoutSeconds = 30;
    /**
     * When true, expose the NetHub PUBLIC catalog anonymously (GET /api/hub/public/**) AND the
     * package-registry GET browse — the "public hub" opt-in. Default OFF: no token ⇒ nothing.
     */
    private boolean hubPublicCatalog = false;
    /**
     * When true, expose the share-link exchange anonymously (POST /oauth2/share) so a
     * read-only net link works without an account. Default OFF: no token ⇒ nothing.
     */
    private boolean shareEnabled = false;
    /**
     * Lifetime of the share-scoped JWT minted by the exchange. Short by design: the link may live
     * for weeks, but each token it issues is disposable and the page re-exchanges silently.
     */
    private int shareTokenTtlSeconds = 900;

    public String getMasterUrl() {
        return masterUrl;
    }

    public void setMasterUrl(String masterUrl) {
        this.masterUrl = masterUrl;
    }

    public String getNodeUrl() {
        return nodeUrl;
    }

    public void setNodeUrl(String nodeUrl) {
        this.nodeUrl = nodeUrl;
    }

    public String getVaultUrl() {
        return vaultUrl;
    }

    public void setVaultUrl(String vaultUrl) {
        this.vaultUrl = vaultUrl;
    }

    public int getTimeoutSeconds() {
        return timeoutSeconds;
    }

    public void setTimeoutSeconds(int timeoutSeconds) {
        this.timeoutSeconds = timeoutSeconds;
    }

    public int getProxyTimeoutSeconds() {
        return proxyTimeoutSeconds;
    }

    public void setProxyTimeoutSeconds(int proxyTimeoutSeconds) {
        this.proxyTimeoutSeconds = proxyTimeoutSeconds;
    }

    public String getClientId() {
        return clientId;
    }

    public void setClientId(String clientId) {
        this.clientId = clientId;
    }

    public String getClientSecret() {
        return clientSecret;
    }

    public void setClientSecret(String clientSecret) {
        this.clientSecret = clientSecret;
    }

    public String getReadonlyClientId() {
        return readonlyClientId;
    }

    public void setReadonlyClientId(String readonlyClientId) {
        this.readonlyClientId = readonlyClientId;
    }

    public String getReadonlyClientSecret() {
        return readonlyClientSecret;
    }

    public void setReadonlyClientSecret(String readonlyClientSecret) {
        this.readonlyClientSecret = readonlyClientSecret;
    }

    public String getExecutorClientId() {
        return executorClientId;
    }

    public void setExecutorClientId(String executorClientId) {
        this.executorClientId = executorClientId;
    }

    public String getExecutorClientSecret() {
        return executorClientSecret;
    }

    public void setExecutorClientSecret(String executorClientSecret) {
        this.executorClientSecret = executorClientSecret;
    }

    public String getJwtKeyDir() {
        return jwtKeyDir;
    }

    public void setJwtKeyDir(String jwtKeyDir) {
        this.jwtKeyDir = jwtKeyDir;
    }

    public int getTokenTtlSeconds() {
        return tokenTtlSeconds;
    }

    public void setTokenTtlSeconds(int tokenTtlSeconds) {
        this.tokenTtlSeconds = tokenTtlSeconds;
    }

    public int getRateLimitPerMinute() {
        return rateLimitPerMinute;
    }

    public void setRateLimitPerMinute(int rateLimitPerMinute) {
        this.rateLimitPerMinute = rateLimitPerMinute;
    }

    public String getTrustedProxies() {
        return trustedProxies;
    }

    public void setTrustedProxies(String trustedProxies) {
        this.trustedProxies = trustedProxies;
    }

    public String getInternalSecret() {
        return internalSecret;
    }

    public void setInternalSecret(String internalSecret) {
        this.internalSecret = internalSecret;
    }

    public int getMasterHeartbeatTtlSeconds() {
        return masterHeartbeatTtlSeconds;
    }

    public void setMasterHeartbeatTtlSeconds(int masterHeartbeatTtlSeconds) {
        this.masterHeartbeatTtlSeconds = masterHeartbeatTtlSeconds;
    }

    public int getProxyFanOutTimeoutSeconds() {
        return proxyFanOutTimeoutSeconds;
    }

    public void setProxyFanOutTimeoutSeconds(int proxyFanOutTimeoutSeconds) {
        this.proxyFanOutTimeoutSeconds = proxyFanOutTimeoutSeconds;
    }

    public boolean isHubPublicCatalog() {
        return hubPublicCatalog;
    }

    public void setHubPublicCatalog(boolean hubPublicCatalog) {
        this.hubPublicCatalog = hubPublicCatalog;
    }

    public boolean isShareEnabled() {
        return shareEnabled;
    }

    public void setShareEnabled(boolean shareEnabled) {
        this.shareEnabled = shareEnabled;
    }

    public int getShareTokenTtlSeconds() {
        return shareTokenTtlSeconds;
    }

    public void setShareTokenTtlSeconds(int shareTokenTtlSeconds) {
        this.shareTokenTtlSeconds = shareTokenTtlSeconds;
    }
}
