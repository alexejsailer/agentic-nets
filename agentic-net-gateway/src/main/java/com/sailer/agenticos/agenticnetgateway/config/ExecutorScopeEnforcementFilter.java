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
import java.util.regex.Pattern;

/**
 * Restricts executor-scoped JWTs to the executor polling protocol.
 *
 * <p>The {@code agenticos-executor} OAuth2 client exists so remote executors can authenticate
 * through the gateway without holding the full admin credential. A token whose {@code scope}
 * claim contains {@code executor} may ONLY call the endpoints the polling loop actually uses:
 * <ul>
 *   <li>{@code GET  /api/transitions/poll}</li>
 *   <li>{@code GET  /api/transitions/discover}</li>
 *   <li>{@code POST /api/transitions/{transitionId}/deployment}</li>
 *   <li>{@code POST /api/transitions/tokens/emit}</li>
 *   <li>{@code POST /api/transitions/tokens/consume}</li>
 *   <li>{@code POST /api/transitions/tokens/release}</li>
 * </ul>
 * Everything else under {@code /api/**}, {@code /node-api/**}, and {@code /vault-api/**} is
 * rejected with {@code 403 {"error":"executor_scope"}} — an executor credential must not be able
 * to assign transitions, plant credentials, read arbitrary places, or reach node/vault directly.
 *
 * <p>Runs after the OAuth2 JWT authentication filter (same placement as
 * {@link ReadonlyEnforcementFilter}). Non-executor tokens pass through untouched.
 */
@Component
public class ExecutorScopeEnforcementFilter extends OncePerRequestFilter {

    private static final Logger logger = LoggerFactory.getLogger(ExecutorScopeEnforcementFilter.class);

    private static final String EXECUTOR_SCOPE = "executor";

    private static final Pattern EXECUTOR_GET = Pattern.compile(
            "^/api/transitions/(poll|discover)$");
    private static final Pattern EXECUTOR_POST = Pattern.compile(
            "^/api/transitions/([^/]+/deployment|tokens/(emit|consume|release))$");

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
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!(auth instanceof JwtAuthenticationToken jwtAuth)) {
            filterChain.doFilter(request, response);
            return;
        }

        Jwt jwt = jwtAuth.getToken();
        String scope = jwt.getClaimAsString("scope");
        if (scope == null || !containsToken(scope, EXECUTOR_SCOPE)) {
            filterChain.doFilter(request, response);
            return;
        }

        if (isExecutorAllowed(request.getMethod(), request.getRequestURI())) {
            filterChain.doFilter(request, response);
            return;
        }

        logger.info("Rejecting {} {} for executor subject={}",
                request.getMethod(), request.getRequestURI(), jwt.getSubject());
        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType("application/json");
        response.getWriter().write(
                "{\"error\":\"executor_scope\","
                        + "\"message\":\"This token is limited to the executor polling protocol.\"}");
    }

    private static boolean isExecutorAllowed(String method, String uri) {
        if (uri == null || method == null) return false;
        if ("GET".equalsIgnoreCase(method)) {
            return EXECUTOR_GET.matcher(uri).matches();
        }
        if ("POST".equalsIgnoreCase(method)) {
            return EXECUTOR_POST.matcher(uri).matches();
        }
        return false;
    }

    private static boolean containsToken(String scope, String token) {
        for (String part : scope.split("\\s+")) {
            if (token.equals(part)) return true;
        }
        return false;
    }
}
