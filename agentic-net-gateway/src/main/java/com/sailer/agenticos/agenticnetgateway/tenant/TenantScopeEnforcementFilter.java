package com.sailer.agenticos.agenticnetgateway.tenant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.sailer.agenticos.agenticnetgateway.config.GatewayRequestPaths;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;

/**
 * The tenant fence, and the fail-closed scope gate for every token.
 *
 * <ol>
 *   <li>Every JWT must carry one of the known roles (admin, readonly, executor, share, tenant).
 *       Before this filter an unknown scope fell through every scoped filter as full admin.</li>
 *   <li>A token with a {@code tenant} claim must still be valid in the {@link TenantRegistry}
 *       (tenant enabled, key not rotated, executor not removed): revocation is immediate.</li>
 *   <li>Its requests go through {@link TenantRoutePolicy} (default deny, own models only), its own
 *       rate limit, and its model quota on create; model lists come back filtered to its models.</li>
 * </ol>
 * Operator tokens (no tenant claim) pass unchanged after the scope gate.
 */
@Component
public class TenantScopeEnforcementFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(TenantScopeEnforcementFilter.class);
    private static final Set<String> KNOWN_ROLES = Set.of("admin", "readonly", "executor", "share", "tenant");
    private static final long WINDOW_SECONDS = 60;

    private final TenantRegistry registry;
    private final TenancySettings settings;
    private final TenantModelDirectory directory;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Map<String, Deque<Instant>> windows = new ConcurrentHashMap<>();

    public TenantScopeEnforcementFilter(TenantRegistry registry, TenancySettings settings, TenantModelDirectory directory) {
        this.registry = registry;
        this.settings = settings;
        this.directory = directory;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String uri = GatewayRequestPaths.effectivePath(request);
        if (uri == null) return true;
        return !(uri.startsWith("/api/") || uri.startsWith("/node-api/") || uri.startsWith("/vault-api/"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!(auth instanceof JwtAuthenticationToken jwtAuth)) {
            chain.doFilter(request, response);
            return;
        }
        Jwt jwt = jwtAuth.getToken();
        String scope = jwt.getClaimAsString("scope");
        if (!hasKnownRole(scope)) {
            reject(response, 403, "unknown_scope", "This token carries no role this gateway knows.");
            return;
        }
        String tenant = jwt.getClaimAsString("tenant");
        boolean tenantScope = containsToken(scope, "tenant");
        if (tenant == null || tenant.isBlank()) {
            if (tenantScope) {
                reject(response, 403, "tenant_scope", "A tenant token without a tenant.");
                return;
            }
            chain.doFilter(request, response);
            return;
        }

        String path = GatewayRequestPaths.effectivePath(request);
        if (!settings.enabled()) {
            reject(response, 403, "tenancy_disabled", "This gateway does not accept tenant accounts.");
            return;
        }
        String executorName = jwt.getClaimAsString("executorName");
        Object kv = jwt.getClaims().get("kv");
        Integer keyVersion = kv instanceof Number n ? n.intValue() : null;
        if (!registry.stillValid(tenant, keyVersion, executorName)) {
            reject(response, 401, "tenant_revoked", "This account's key was rotated or the account is disabled; sign in again.");
            return;
        }
        if (path.startsWith("/vault-api/")) {
            reject(response, 403, "tenant_scope", "Tenant accounts set credentials through the transition credentials route only.");
            return;
        }
        TenantRegistry.Tenant t = registry.get(tenant).orElse(null);
        if (t != null && !allow(tenant, t.rateLimitPerMinute())) {
            response.setHeader("Retry-After", String.valueOf(WINDOW_SECONDS));
            reject(response, 429, "tenant_rate_limited", "Too many requests for this account; wait a minute.");
            return;
        }

        String contentType = request.getContentType();
        if (contentType != null && contentType.toLowerCase(java.util.Locale.ROOT).startsWith("application/x-www-form-urlencoded")) {
            // Form bodies become request parameters on the backend and could name a second model.
            reject(response, 415, "tenant_scope", "Tenant requests send JSON bodies.");
            return;
        }
        Map<String, String[]> query = parseQuery(request.getQueryString());
        byte[] body;
        try (InputStream in = request.getInputStream()) {
            body = in.readNBytes(settings.maxBodyBytes() + 1);
        }
        if (body.length > settings.maxBodyBytes()) {
            reject(response, 413, "tenant_body_too_large", "Request bodies are limited to " + settings.maxBodyBytes() + " bytes.");
            return;
        }
        CachedBodyRequest cached = new CachedBodyRequest(request, body);
        String executorId = executorName == null ? null : TenantKeys.executorId(tenant, executorName);
        TenantRoutePolicy.Decision d = TenantRoutePolicy.decide(tenant, executorId,
                new TenantRoutePolicy.Request(request.getMethod(), path, query, body));
        if (!d.allowed()) {
            log.info("Tenant '{}' refused {} {}: {}", tenant, request.getMethod(), path, d.error());
            reject(response, 403, d.error(), d.message());
            return;
        }

        if (d.effect() == TenantRoutePolicy.Effect.CREATE_MODEL) {
            int max = t == null ? 0 : t.modelsMax();
            List<String> existing;
            try {
                existing = directory.modelsOf(tenant);
            } catch (Exception e) {
                reject(response, 503, "tenant_quota_unknown", "The model list could not be read to check your quota; try again.");
                return;
            }
            String requested = d.models().isEmpty() ? null : d.models().iterator().next();
            if (!existing.contains(requested) && existing.size() >= max) {
                reject(response, 403, "tenant_quota", "Your account may hold " + max + " models and has " + existing.size()
                        + "; delete one first or ask the operator for more.");
                return;
            }
        }

        if (d.effect() == TenantRoutePolicy.Effect.LIST_MODELS) {
            // Answered here, never proxied: master's list is node's list passed through, and an
            // unfiltered answer must not exist even for a moment (the master proxy streams async).
            List<JsonNode> mine;
            try {
                mine = directory.modelEntriesOf(tenant);
            } catch (Exception e) {
                reject(response, 503, "models_unavailable", "The model list could not be read; try again.");
                return;
            }
            ArrayNode out = mapper.createArrayNode();
            mine.forEach(out::add);
            byte[] json = mapper.writeValueAsBytes(out);
            response.setStatus(200);
            response.setContentType("application/json");
            response.setContentLength(json.length);
            response.getOutputStream().write(json);
            return;
        }
        chain.doFilter(cached, response);
    }

    /** The query string as the backend will decode it, every value of every name. */
    static Map<String, String[]> parseQuery(String query) {
        Map<String, java.util.List<String>> acc = new java.util.LinkedHashMap<>();
        if (query != null && !query.isEmpty()) {
            for (String pair : query.split("&")) {
                if (pair.isEmpty()) continue;
                int eq = pair.indexOf('=');
                String k = decode(eq < 0 ? pair : pair.substring(0, eq));
                String v = eq < 0 ? "" : decode(pair.substring(eq + 1));
                acc.computeIfAbsent(k, x -> new java.util.ArrayList<>()).add(v);
            }
        }
        Map<String, String[]> out = new java.util.LinkedHashMap<>();
        acc.forEach((k, v) -> out.put(k, v.toArray(String[]::new)));
        return out;
    }

    private static String decode(String s) {
        try {
            return java.net.URLDecoder.decode(s, java.nio.charset.StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return s;
        }
    }

    private boolean allow(String tenant, int limit) {
        Instant now = Instant.now();
        Deque<Instant> q = windows.computeIfAbsent(tenant, k -> new ConcurrentLinkedDeque<>());
        Instant cutoff = now.minusSeconds(WINDOW_SECONDS);
        while (!q.isEmpty() && q.peekFirst().isBefore(cutoff)) q.pollFirst();
        if (q.size() >= limit) return false;
        q.addLast(now);
        return true;
    }

    private static boolean hasKnownRole(String scope) {
        if (scope == null) return false;
        for (String part : scope.split("\\s+")) {
            if (KNOWN_ROLES.contains(part)) return true;
        }
        return false;
    }

    private static boolean containsToken(String scope, String token) {
        if (scope == null) return false;
        for (String part : scope.split("\\s+")) if (token.equals(part)) return true;
        return false;
    }

    private static void reject(HttpServletResponse response, int status, String error, String message) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\":\"" + error + "\",\"message\":\"" + message.replace("\"", "'") + "\"}");
    }
}
