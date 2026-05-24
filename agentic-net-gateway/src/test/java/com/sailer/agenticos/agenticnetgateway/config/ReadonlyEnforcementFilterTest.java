package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
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

class ReadonlyEnforcementFilterTest {

    private final ReadonlyEnforcementFilter filter = new ReadonlyEnforcementFilter();

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void shouldNotFilter_passesForUnrelatedPaths() {
        assertThat(filter.shouldNotFilter(request("GET", "/oauth2/token"))).isTrue();
        assertThat(filter.shouldNotFilter(request("GET", "/actuator/health"))).isTrue();
        assertThat(filter.shouldNotFilter(request("POST", "/api/models"))).isFalse();
        assertThat(filter.shouldNotFilter(request("GET", "/node-api/models"))).isFalse();
        assertThat(filter.shouldNotFilter(request("PUT", "/vault-api/secrets"))).isFalse();
    }

    @Test
    void getRequest_readonlyScope_isAllowed() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("GET", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void postRequest_readonlyScope_isBlockedWith403() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("POST", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
        assertThat(res.getContentType()).isEqualTo("application/json");
        assertThat(res.getContentAsString()).contains("readonly_scope");
    }

    @Test
    void putAndDeleteAndPatch_readonlyScope_allBlocked() throws Exception {
        for (String method : new String[]{"PUT", "DELETE", "PATCH"}) {
            authenticate("agenticos readonly");
            MockHttpServletRequest req = request(method, "/api/transitions/t-x/inscription");
            MockHttpServletResponse res = new MockHttpServletResponse();
            FilterChain chain = mock(FilterChain.class);

            filter.doFilter(req, res, chain);

            verify(chain, never()).doFilter(req, res);
            assertThat(res.getStatus())
                    .as("method %s should be blocked", method)
                    .isEqualTo(HttpStatus.FORBIDDEN.value());
            SecurityContextHolder.clearContext();
        }
    }

    @Test
    void postRequest_adminScope_isAllowed() throws Exception {
        authenticate("agenticos admin");
        MockHttpServletRequest req = request("POST", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void postRequest_noAuthentication_passesThrough() throws Exception {
        // No auth set — filter defers to the rest of the chain (which will reject with 401 elsewhere).
        MockHttpServletRequest req = request("POST", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
    }

    @Test
    void postChatStart_readonlyScope_isAllowed() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("POST", "/api/chat/start");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void postChatMessage_readonlyScope_isAllowed() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("POST", "/api/chat/sess-001/message");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void postChatApply_readonlyScope_stillBlocked() throws Exception {
        // /apply mutates nets — the chat-send exception must NOT cover it.
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("POST", "/api/chat/sess-001/apply");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
        assertThat(res.getContentAsString()).contains("readonly_scope");
    }

    @Test
    void postReadonlyMonitorPersonaStart_isAllowed() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("POST", "/api/assistant/p/domain-expert-readonly/safe-teams/chat/start");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void postReadonlyMonitorPersonaAgentStream_isAllowed() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("POST", "/api/assistant/p/domain-expert-readonly/safe-teams/chat/conv-001/agent-stream");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void postOtherPersonaAgentStream_readonlyScope_stillBlocked() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("POST", "/api/assistant/p/builder/safe-teams/chat/conv-001/agent-stream");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
        assertThat(res.getContentAsString()).contains("readonly_scope");
    }

    @Test
    void optionsRequest_readonlyScope_isAllowed() throws Exception {
        // CORS preflight must pass through even for readonly tokens.
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("OPTIONS", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
    }

    private static MockHttpServletRequest request(String method, String uri) {
        MockHttpServletRequest req = new MockHttpServletRequest(method, uri);
        req.setRequestURI(uri);
        return req;
    }

    private static void authenticate(String scope) {
        Jwt jwt = Jwt.withTokenValue("test")
                .header("alg", "RS256")
                .subject("test-subject")
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .claims(c -> c.putAll(Map.of("scope", scope)))
                .build();
        Authentication auth = new JwtAuthenticationToken(jwt);
        SecurityContextHolder.getContext().setAuthentication(auth);
    }
}
