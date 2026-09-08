package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.util.UriUtils;

import java.nio.charset.StandardCharsets;

/**
 * Computes the effective request path the way the backend and Spring's route matching see it,
 * so scope filters and the rate limiter can never be bypassed by percent-encoding the path.
 *
 * <p>The servlet API's {@link HttpServletRequest#getRequestURI()} returns the raw, undecoded
 * path. Spring Security's {@code requestMatchers("/api/**")} and Spring MVC dispatch, however,
 * match the <em>decoded</em> path, and the downstream proxy forwards the raw URI to master/node,
 * whose Tomcat decodes it again. A filter that classified on the raw URI therefore saw
 * {@code /%61pi/...} as "not an API path" and skipped enforcement, while the request still
 * reached {@code /api/...} on the backend. Deciding on the decoded path closes that gap.</p>
 *
 * <p>Only percent-decoding is applied (via {@link UriUtils#decode}, which — unlike
 * {@link java.net.URLDecoder} — leaves {@code +} untouched in a path), matching Spring's own
 * single-pass decode. Structural attacks ({@code ..}, {@code ;}, {@code //}, {@code %2F},
 * {@code %2E}, {@code %25}, backslash) are already rejected by Spring Security's default
 * StrictHttpFirewall before any filter here runs, so after the firewall the only remaining
 * transformation between the raw URI and the backend's view is this decode.</p>
 */
final class GatewayRequestPaths {

    private GatewayRequestPaths() {}

    /**
     * The decoded path used for all scope/limit decisions. Fails closed: if the raw URI is null
     * or cannot be decoded (a malformed {@code %} escape the firewall let through), the raw value
     * is returned unchanged so a scoped token still falls through to its default-deny branch
     * rather than matching an allowlist entry it should not.
     */
    static String effectivePath(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null) {
            return null;
        }
        try {
            return UriUtils.decode(uri, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException malformed) {
            return uri;
        }
    }
}
