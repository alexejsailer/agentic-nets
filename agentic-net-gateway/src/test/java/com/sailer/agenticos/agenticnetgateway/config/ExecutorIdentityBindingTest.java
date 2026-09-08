package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
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

/** An executor token bound to one executor id cannot poll as another; unbound tokens keep working. */
class ExecutorIdentityBindingTest {

    private final ExecutorScopeEnforcementFilter filter = new ExecutorScopeEnforcementFilter();

    @AfterEach
    void clear() { SecurityContextHolder.clearContext(); }

    private static void auth(String boundExecutorId) {
        Jwt.Builder b = Jwt.withTokenValue("t").header("alg", "RS256").subject("agenticos-executor")
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(600))
                .claims(c -> c.putAll(Map.of("scope", "agenticos executor")));
        if (boundExecutorId != null) b.claim("executorId", boundExecutorId);
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(b.build()));
    }

    private int poll(String executorIdParam) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/transitions/poll");
        req.setRequestURI("/api/transitions/poll");
        req.setParameter("modelId", "default");
        req.setParameter("executorId", executorIdParam);
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);
        filter.doFilter(req, res, chain);
        if (res.getStatus() == 200) verify(chain, times(1)).doFilter(req, res); else verify(chain, never()).doFilter(req, res);
        return res.getStatus();
    }

    @Test
    void boundTokenMayOnlyPollAsItself() throws Exception {
        auth("agentic-net-executor-2");
        assertThat(poll("agentic-net-executor-2")).isEqualTo(200);
        assertThat(poll("agentic-net-executor-default")).isEqualTo(403);
    }

    @Test
    void unboundLegacyTokenIsUnchanged() throws Exception {
        auth(null);
        assertThat(poll("anything")).isEqualTo(200);
    }
}
