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
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Restricts share-scoped JWTs to reading ONE net, read-only.
 *
 * <p>A token minted by {@code POST /oauth2/share} carries {@code scope: share} plus the model,
 * session, net and PNML container it may read. Deliberately NOT the place and transition ids:
 * the token travels in a header on every request, and a 133-transition net would push it past
 * the 8 KB default header limit. The server resolves the members from the net name instead.
 * This filter enforces those claims on every subsequent call:</p>
 * <ol>
 *   <li>the request's modelId must equal the claim, so a link to one model cannot read another;</li>
 *   <li>the method and path must appear in {@link #ALLOWED} below, a deliberately tiny list;</li>
 *   <li>container reads must match the exact container claim, and net-scoped reads must name
 *       the exact session/net claims rather than enumerating ids the filter would have to
 *       trust.</li>
 * </ol>
 *
 * <p>Everything else under {@code /api/**}, {@code /node-api/**} and {@code /vault-api/**} is
 * rejected with {@code 403 {"error":"share_scope"}}. That matters more here than for the other
 * scopes: this is the only credential in the system that can reach an anonymous stranger, and
 * {@code GET /api/transitions/{id}/credentials} returns plaintext secrets.</p>
 *
 * <p>Two entries are gated on the link's own tab allowlist (the {@code tabs} claim), so a link
 * created without the console tab cannot stream the model's event line by hand.</p>
 *
 * <p>Runs after {@link ExecutorScopeEnforcementFilter}. Non-share tokens pass through untouched.</p>
 */
@Component
public class ShareScopeEnforcementFilter extends OncePerRequestFilter {

    private static final Logger logger = LoggerFactory.getLogger(ShareScopeEnforcementFilter.class);

    private static final String SHARE_SCOPE = "share";

    /**
     * One entry per endpoint the shared page actually calls. Group 1 of every pattern is the
     * modelId, which is matched against the token claim.
     */
    private enum ScopeKind { CONTAINER, NET }

    private record Rule(String method, Pattern pattern, String requiredTab,
                        ScopeKind scopeKind, String queryParameter) {}

    private static final List<Rule> ALLOWED = List.of(
            // The net itself: PNML export by container uuid. The second segment is pinned to a
            // UUID on purpose — a loose [^/]+ would also match sibling routes on the same
            // controller, notably GET /api/pnml/{modelId}/sessions, which lists every session
            // in the model.
            new Rule("GET", Pattern.compile(
                    "^/api/pnml/([^/]+)/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"),
                    null, ScopeKind.CONTAINER, null),
            // Live token counts for the whole net in one call. Net-scoped by NAME: master
            // resolves which places belong to the net. node's batch endpoint stays off the list
            // because a servlet filter cannot safely authorize an opaque POST body, and the
            // one-request-per-place alternative was an unthrottled N+1 through the gateway.
            new Rule("GET", Pattern.compile("^/api/models/([^/]+)/net-token-counts$"),
                    null, ScopeKind.NET, null),
            // Transition firing/deployed/scheduled badges on the canvas. Net-scoped by NAME:
            // master resolves which transitions belong to the net, so the browser never sends
            // the list and this filter never has to trust one.
            new Rule("GET", Pattern.compile("^/api/models/([^/]+)/execution/status$"),
                    null, ScopeKind.NET, null),
            // Console tab: the activity feed, plain and SSE. Same net-scoping.
            new Rule("GET", Pattern.compile("^/api/event-line/([^/]+)(?:/stream)?$"),
                    "console", ScopeKind.NET, null)
    );

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
        if (scope == null || !containsToken(scope, SHARE_SCOPE)) {
            filterChain.doFilter(request, response);
            return;
        }

        String claimedModel = jwt.getClaimAsString("modelId");
        String claimedContainer = jwt.getClaimAsString("containerId");
        String claimedSession = jwt.getClaimAsString("sessionId");
        String claimedNet = jwt.getClaimAsString("netId");
        String tabs = jwt.getClaimAsString("tabs");

        if (claimedModel != null && !claimedModel.isBlank()
                && isShareAllowed(request, claimedModel, claimedContainer, claimedSession,
                        claimedNet, tabs)) {
            filterChain.doFilter(request, response);
            return;
        }

        logger.info("Rejecting {} {} for share subject={} model={}",
                request.getMethod(), request.getRequestURI(), jwt.getSubject(), claimedModel);
        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType("application/json");
        response.getWriter().write(
                "{\"error\":\"share_scope\","
                        + "\"message\":\"This link is limited to read-only access to one net.\"}");
    }

    private static boolean isShareAllowed(HttpServletRequest request, String claimedModel,
                                          String claimedContainer, String claimedSession,
                                          String claimedNet, String tabs) {
        String method = request.getMethod();
        String uri = request.getRequestURI();
        if (uri == null || method == null) return false;
        for (Rule rule : ALLOWED) {
            if (!rule.method().equalsIgnoreCase(method)) {
                continue;
            }
            Matcher matcher = rule.pattern().matcher(uri);
            if (!matcher.matches()) {
                continue;
            }
            if (!claimedModel.equals(matcher.group(1))) {
                return false;
            }
            if (rule.requiredTab() != null && !containsToken(tabs, rule.requiredTab())) {
                return false;
            }
            return switch (rule.scopeKind()) {
                case CONTAINER -> claimedContainer != null
                        && claimedContainer.equalsIgnoreCase(matcher.group(2));
                case NET -> isClaimedNet(request, claimedSession, claimedNet);
            };
        }
        return false;
    }

    /**
     * The request must name exactly the net in the token, and must not additionally try to widen
     * itself with a hand-written transition filter.
     */
    private static boolean isClaimedNet(HttpServletRequest request, String claimedSession,
                                        String claimedNet) {
        if (claimedSession == null || claimedSession.isBlank()
                || claimedNet == null || claimedNet.isBlank()) {
            return false;
        }
        if (request.getParameterValues("transitionId") != null
                || request.getParameterValues("transitionIds") != null) {
            // Master would honour these alongside the net scope; refuse rather than reason about
            // which of two filters wins.
            return false;
        }
        return claimedSession.equals(request.getParameter("netSessionId"))
                && claimedNet.equals(request.getParameter("netId"));
    }

    private static boolean containsToken(String haystack, String token) {
        if (haystack == null) return false;
        for (String part : haystack.split("\\s+")) {
            if (token.equals(part)) return true;
        }
        return false;
    }
}
