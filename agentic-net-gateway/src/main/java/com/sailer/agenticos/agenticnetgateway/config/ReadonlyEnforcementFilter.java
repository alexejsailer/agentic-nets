package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/**
 * Blocks mutating requests carrying a readonly-scoped JWT.
 *
 * <p>When the authenticated {@link Jwt} contains {@code readonly} in its {@code scope}
 * claim, this filter allows only safe HTTP methods ({@code GET}, {@code HEAD},
 * {@code OPTIONS}) on proxied API paths ({@code /api/**}, {@code /node-api/**},
 * {@code /vault-api/**}) and rejects everything else with {@code 403} and a
 * JSON body {@code {"error":"readonly_scope",...}}.
 *
 * <p>Runs after the OAuth2 JWT authentication filter so the {@link Authentication}
 * is available in the {@link SecurityContextHolder}. Requests that aren't
 * authenticated with a JWT fall through to the chain's normal behavior.
 */
@Component
public class ReadonlyEnforcementFilter extends OncePerRequestFilter {

    private static final Logger logger = LoggerFactory.getLogger(ReadonlyEnforcementFilter.class);

    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS");
    private static final String READONLY_SCOPE = "readonly";

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null) return true;
        return !(uri.startsWith("/api/")
                || uri.startsWith("/node-api/")
                || uri.startsWith("/vault-api/"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        if (SAFE_METHODS.contains(request.getMethod().toUpperCase())) {
            filterChain.doFilter(request, response);
            return;
        }

        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!(auth instanceof JwtAuthenticationToken jwtAuth)) {
            filterChain.doFilter(request, response);
            return;
        }

        Jwt jwt = jwtAuth.getToken();
        String scope = jwt.getClaimAsString("scope");
        if (scope == null || !containsToken(scope, READONLY_SCOPE)) {
            filterChain.doFilter(request, response);
            return;
        }

        logger.info("Rejecting {} {} for readonly subject={}",
                request.getMethod(), request.getRequestURI(), jwt.getSubject());
        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType("application/json");
        response.getWriter().write(
                "{\"error\":\"readonly_scope\","
                        + "\"message\":\"This token is read-only; mutating requests are not permitted.\"}");
    }

    private static boolean containsToken(String scope, String token) {
        for (String part : scope.split("\\s+")) {
            if (token.equals(part)) return true;
        }
        return false;
    }
}
