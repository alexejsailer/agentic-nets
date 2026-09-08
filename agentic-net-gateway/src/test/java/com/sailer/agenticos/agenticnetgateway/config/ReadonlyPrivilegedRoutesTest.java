package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * "GET is safe" must not apply to the executor protocol, plaintext credential reads, or the SSE
 * agent-loop endpoints. Ordinary reads (model list, transition list) stay open for readonly.
 */
class ReadonlyPrivilegedRoutesTest {

    private final ReadonlyEnforcementFilter filter = new ReadonlyEnforcementFilter();

    @AfterEach
    void clear() { SecurityContextHolder.clearContext(); }

    private int run(String scope, String method, String uri) throws Exception {
        if (scope != null) authenticate(scope);
        MockHttpServletRequest req = new MockHttpServletRequest(method, uri);
        req.setRequestURI(uri);
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);
        filter.doFilter(req, res, chain);
        if (res.getStatus() == 200) verify(chain, times(1)).doFilter(req, res);
        else verify(chain, never()).doFilter(req, res);
        return res.getStatus();
    }

    @Test
    void readonly_executorPollAndDiscover_denied() throws Exception {
        assertThat(run("agenticos readonly", "GET", "/api/transitions/poll")).isEqualTo(403);
        assertThat(run("agenticos readonly", "GET", "/api/transitions/discover")).isEqualTo(403);
        assertThat(run("agenticos readonly", "GET", "/api/transitions/t-x/credentials")).isEqualTo(403);
        assertThat(run("agenticos readonly", "GET", "/api/transitions/tokens/emit")).isEqualTo(403);
    }

    @Test
    void readonly_agentStreamForOtherPersonas_denied_pinnedPersona_allowed() throws Exception {
        assertThat(run("agenticos readonly", "GET",
                "/api/assistant/p/builder/default/chat/c1/agent-stream")).isEqualTo(403);
        assertThat(run("agenticos readonly", "GET",
                "/api/assistant/universal/default/chat/c1/agent-stream")).isEqualTo(403);
        assertThat(run("agenticos readonly", "GET",
                "/api/assistant/p/domain-expert-readonly/default/chat/c1/agent-stream")).isEqualTo(200);
    }

    @Test
    void readonly_ordinaryReads_stillAllowed() throws Exception {
        assertThat(run("agenticos readonly", "GET", "/api/admin/models")).isEqualTo(200);
        assertThat(run("agenticos readonly", "GET", "/api/transitions")).isEqualTo(200);
        assertThat(run("agenticos readonly", "GET", "/api/transitions/t-x")).isEqualTo(200);
    }

    @Test
    void admin_privilegedRoutes_allowed() throws Exception {
        assertThat(run("agenticos admin", "GET", "/api/transitions/poll")).isEqualTo(200);
        assertThat(run("agenticos admin", "GET",
                "/api/assistant/p/builder/default/chat/c1/agent-stream")).isEqualTo(200);
    }

    @Test
    void missingScope_onPrivilegedOrMutatingRoute_failsClosed() throws Exception {
        assertThat(run("", "POST", "/api/models")).isEqualTo(403);
        assertThat(run("", "GET", "/api/transitions/poll")).isEqualTo(403);
    }

    @Test
    void rateLimiter_trailingSlash_stillLimited() {
        TokenRateLimiter limiter = new TokenRateLimiter(new GatewayProperties());
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/oauth2/token/");
        req.setRequestURI("/oauth2/token/");
        assertThat(limiter.shouldNotFilter(req)).isFalse();
    }

    private static void authenticate(String scope) {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "RS256").subject("s")
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(600))
                .claims(c -> c.putAll(Map.of("scope", scope))).build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
    }
}
