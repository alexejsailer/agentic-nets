package com.sailer.blobstore.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Requires {@code X-Service-Auth: Bearer <AGENTICOS_SERVICE_TOKEN>} on the service API when a token
 * is configured. Closes the "any process that can reach the port owns the service" gap: on a
 * shared machine or a mis-published compose port, node/master/vault/blobstore no longer answer to
 * whoever connects. Health and metrics endpoints stay open for supervisors; CORS preflights pass.
 * With no token configured the filter is inert.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ServiceTokenFilter extends OncePerRequestFilter {

    private static final Logger logger = LoggerFactory.getLogger(ServiceTokenFilter.class);

    public ServiceTokenFilter(@Value("${agenticos.service.token:}") String token) {
        ServiceAuth.configure(token);
        if (ServiceAuth.enabled()) {
            logger.info("Internal service authentication ENABLED (X-Service-Auth required on the API)");
        } else {
            logger.info("Internal service authentication not configured (AGENTICOS_SERVICE_TOKEN unset)");
        }
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!ServiceAuth.enabled()) return true;
        String m = request.getMethod();
        if ("OPTIONS".equalsIgnoreCase(m)) return true;
        String p = request.getRequestURI();
        if (p == null) return true;
        if (p.startsWith("/actuator/") || p.equals("/health") || p.startsWith("/api/health")
                || p.equals("/api/blobs/health") || p.startsWith("/api/cluster/")
                || p.startsWith("/internal/")) {
            return true;
        }
        // Blob reads are capability-by-id (unguessable ids) and Studio's read fallback has no token:
        // only writes and deletes require service auth here.
        if ("GET".equalsIgnoreCase(m) || "HEAD".equalsIgnoreCase(m)) return true;
        return !p.startsWith("/api/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        if (ServiceAuth.matches(request.getHeader(ServiceAuth.HEADER))) {
            chain.doFilter(request, response);
            return;
        }
        logger.warn("Rejecting {} {} from {}: missing or wrong X-Service-Auth", request.getMethod(),
                request.getRequestURI(), request.getRemoteAddr());
        response.setStatus(401);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\":\"service_auth_required\","
                + "\"message\":\"This service requires X-Service-Auth (AGENTICOS_SERVICE_TOKEN).\"}");
    }
}
