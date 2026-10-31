package com.sailer.agenticos.agenticnetgateway.tenant;

import org.springframework.http.HttpHeaders;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * The tenant a request acts for, taken from the verified JWT and handed to master and node as
 * {@code X-Agenticos-Tenant}. The proxies strip every inbound {@code X-Agenticos-*} header first,
 * so a client can never supply it; master and node use it to record and check model owners.
 */
public final class TenantHeader {

    public static final String NAME = "X-Agenticos-Tenant";

    private TenantHeader() {}

    /** The tenant claim of the current request's token, or null for operator tokens. */
    public static String current() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof JwtAuthenticationToken jwtAuth) {
            Jwt jwt = jwtAuth.getToken();
            String t = jwt.getClaimAsString("tenant");
            return t == null || t.isBlank() ? null : t;
        }
        return null;
    }

    public static void apply(HttpHeaders headers) {
        String t = current();
        if (t != null) {
            headers.set(NAME, t);
        }
    }
}
