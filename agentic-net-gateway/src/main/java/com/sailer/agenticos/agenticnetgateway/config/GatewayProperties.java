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
    private String jwtKeyDir = "./data/jwt";
    private int tokenTtlSeconds = 3600;
    private int rateLimitPerMinute = 10;
    private String trustedProxies = "";

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
}
