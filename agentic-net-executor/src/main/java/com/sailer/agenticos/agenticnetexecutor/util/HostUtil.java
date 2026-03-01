package com.sailer.agenticos.agenticnetexecutor.util;

/**
 * Utility class for parsing host strings in AgetnticOS inscriptions.
 *
 * Host format: "{modelId}@{host}:{port}"
 * Examples:
 * - "default@localhost:8080" → modelId="default", baseUrl="http://localhost:8080"
 * - "localhost:8080" → modelId=null, baseUrl="http://localhost:8080"
 */
public class HostUtil {

    private HostUtil() {
        // Utility class, no instances
    }

    /**
     * Extract modelId from host string in format "{modelId}@{host}:{port}".
     *
     * @param host The host string from inscription (e.g., "default@localhost:8080")
     * @return The model ID, or null if host doesn't contain @ separator
     * @throws IllegalArgumentException if host is null or blank
     */
    public static String extractModelId(String host) {
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("Host cannot be null or blank");
        }

        if (host.contains("@")) {
            int atIndex = host.indexOf('@');
            return host.substring(0, atIndex);
        }

        return null;
    }

    /**
     * Extract base URL from host string, adding http:// prefix if needed.
     *
     * @param host The host string (e.g., "default@localhost:8080" or "localhost:8080")
     * @return The base URL (e.g., "http://localhost:8080")
     */
    public static String extractBaseUrl(String host) {
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("Host cannot be null or blank");
        }

        String hostPort = host;
        if (host.contains("@")) {
            int atIndex = host.indexOf('@');
            hostPort = host.substring(atIndex + 1);
        }

        if (hostPort.startsWith("http://") || hostPort.startsWith("https://")) {
            return hostPort;
        }

        return "http://" + hostPort;
    }
}
