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
import java.util.regex.Pattern;

/**
 * Blocks mutating requests carrying a readonly-scoped JWT.
 *
 * <p>When the authenticated {@link Jwt} contains {@code readonly} in its {@code scope}
 * claim, this filter allows only safe HTTP methods ({@code GET}, {@code HEAD},
 * {@code OPTIONS}) on proxied API paths ({@code /api/**}, {@code /node-api/**},
 * {@code /vault-api/**}) and rejects everything else with {@code 403} and a
 * JSON body {@code {"error":"readonly_scope",...}}.
 *
 * <p>Narrow exceptions: readonly guests may call the legacy chat-send endpoints
 * ({@code POST /api/chat/start} and {@code POST /api/chat/{sessionId}/message})
 * and the read-only token-count batch endpoint
 * ({@code POST /node-api/models/{modelId}/children/count/batch})
 * and the pinned monitoring persona endpoints
 * ({@code POST /api/assistant/p/domain-expert-readonly/{modelId}/chat/start} and
 * {@code POST /api/assistant/p/domain-expert-readonly/{modelId}/chat/{conversationId}/agent-stream}).
 * This lets the monitoring view talk to its read-only domain expert while all
 * other writes (for example {@code /apply}, generic assistant execution, model
 * mutation, transition control, etc.) remain blocked.
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

    /** Legacy chat send endpoints still allowed for readonly monitoring guests. */
    private static final Pattern READONLY_CHAT_SEND = Pattern.compile("^/api/chat/(start|[^/]+/message)$");
    /** Token-count batch query used by readonly monitor auto-refresh. */
    private static final Pattern READONLY_TOKEN_COUNT_BATCH =
            Pattern.compile("^/node-api/models/[^/]+/children/count/batch$");
    /** Actual pinned monitoring persona endpoints used by the GUI. */
    private static final Pattern READONLY_MONITOR_PERSONA_CHAT =
            Pattern.compile("^/api/assistant/p/domain-expert-readonly/[^/]+/chat/(start|[^/]+/agent-stream)$");
    /**
     * ArcQL query endpoints. These are POST only because the query travels in the body, but they are
     * strictly read operations (token selection — never a mutation), so a readonly guest may call them.
     * Covers node-direct ({@code /node-api/arcql/query/{modelId}}), master ({@code /api/arcql/query/{modelId}}),
     * the master proxy ({@code /api/proxy/arcql/{modelId}/query}), and the runtime place query
     * ({@code /api/runtime/places/{placeId}/tokens/query}).
     */
    private static final Pattern READONLY_ARCQL_QUERY = Pattern.compile(
            "^/(api|node-api)/arcql/query/[^/]+$"
            + "|^/api/proxy/arcql/[^/]+/query$"
            + "|^/api/runtime/places/[^/]+/tokens/query$");

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

        if ("POST".equalsIgnoreCase(request.getMethod()) && isReadonlyAllowedPost(request.getRequestURI())) {
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

    private static boolean isReadonlyAllowedPost(String uri) {
        return uri != null
                && (READONLY_CHAT_SEND.matcher(uri).matches()
                || READONLY_TOKEN_COUNT_BATCH.matcher(uri).matches()
                || READONLY_MONITOR_PERSONA_CHAT.matcher(uri).matches()
                || READONLY_ARCQL_QUERY.matcher(uri).matches());
    }

    private static boolean containsToken(String scope, String token) {
        for (String part : scope.split("\\s+")) {
            if (token.equals(part)) return true;
        }
        return false;
    }
}
