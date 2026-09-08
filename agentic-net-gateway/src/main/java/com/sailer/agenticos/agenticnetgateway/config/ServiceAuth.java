package com.sailer.agenticos.agenticnetgateway.config;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.function.Consumer;

/**
 * Internal service authentication: a shared token ({@code AGENTICOS_SERVICE_TOKEN}, or the
 * {@code agenticos.service.token} property) that every service-to-service call carries as
 * {@code X-Service-Auth: Bearer <token>} and that node, master, vault and blobstore require on
 * their APIs when it is configured. Unset = today's behaviour (open on the trusted network).
 *
 * <p>Read from the environment first so clients built in constructors (before Spring property
 * injection) see it; {@link #configure(String)} lets the server filter push a property-file value
 * in for anything created later. Comparison is constant-time.</p>
 */
public final class ServiceAuth {

    public static final String HEADER = "X-Service-Auth";
    private static volatile String configured;

    private ServiceAuth() {}

    public static String token() {
        String t = configured;
        if (t != null && !t.isBlank()) return t;
        t = System.getenv("AGENTICOS_SERVICE_TOKEN");
        if (t != null && !t.isBlank()) return t;
        t = System.getProperty("agenticos.service.token");
        return t == null ? "" : t;
    }

    /** Sets (or, with null/blank, clears) the property-file value; the environment still applies. */
    public static void configure(String token) {
        configured = (token == null || token.isBlank()) ? null : token;
    }

    public static boolean enabled() {
        return !token().isBlank();
    }

    /** Adds the header when a token is configured; usable as a {@code Consumer<HttpHeaders>}. */
    public static void apply(org.springframework.http.HttpHeaders headers) {
        String t = token();
        if (!t.isBlank()) headers.set(HEADER, "Bearer " + t);
    }

    public static Consumer<org.springframework.http.HttpHeaders> applier() {
        return ServiceAuth::apply;
    }

    /** Constant-time check of an inbound header value against the configured token. */
    public static boolean matches(String headerValue) {
        String t = token();
        if (t.isBlank() || headerValue == null) return false;
        String presented = headerValue.regionMatches(true, 0, "Bearer ", 0, 7)
                ? headerValue.substring(7).trim() : headerValue.trim();
        try {
            MessageDigest d = MessageDigest.getInstance("SHA-256");
            byte[] a = d.digest(presented.getBytes(StandardCharsets.UTF_8));
            byte[] b = MessageDigest.getInstance("SHA-256").digest(t.getBytes(StandardCharsets.UTF_8));
            return MessageDigest.isEqual(a, b);
        } catch (java.security.NoSuchAlgorithmException e) {
            return false;
        }
    }
}
