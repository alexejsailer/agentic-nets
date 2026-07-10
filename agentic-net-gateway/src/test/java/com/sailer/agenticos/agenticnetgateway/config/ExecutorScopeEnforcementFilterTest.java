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

/**
 * Pins the executor-scope containment contract: an {@code agenticos-executor} token is a
 * machine credential for the polling protocol ONLY. If it could assign transitions or read
 * arbitrary places, a leaked executor secret would be as bad as a leaked admin secret.
 */
class ExecutorScopeEnforcementFilterTest {

    private final ExecutorScopeEnforcementFilter filter = new ExecutorScopeEnforcementFilter();

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void shouldNotFilter_passesForUnrelatedPaths() {
        assertThat(filter.shouldNotFilter(request("POST", "/oauth2/token"))).isTrue();
        assertThat(filter.shouldNotFilter(request("GET", "/actuator/health"))).isTrue();
        assertThat(filter.shouldNotFilter(request("GET", "/api/transitions/poll"))).isFalse();
        assertThat(filter.shouldNotFilter(request("GET", "/node-api/models"))).isFalse();
    }

    @Test
    void pollingProtocolEndpoints_executorScope_areAllowed() throws Exception {
        record Call(String method, String uri) {}
        for (Call call : new Call[]{
                new Call("GET", "/api/transitions/poll"),
                new Call("GET", "/api/transitions/discover"),
                new Call("POST", "/api/transitions/t-build-cmd/deployment"),
                new Call("POST", "/api/transitions/tokens/emit"),
                new Call("POST", "/api/transitions/tokens/consume"),
                new Call("POST", "/api/transitions/tokens/release")}) {
            authenticate("agenticos executor");
            MockHttpServletRequest req = request(call.method(), call.uri());
            MockHttpServletResponse res = new MockHttpServletResponse();
            FilterChain chain = mock(FilterChain.class);

            filter.doFilter(req, res, chain);

            verify(chain, times(1)).doFilter(req, res);
            assertThat(res.getStatus()).as("%s %s", call.method(), call.uri())
                    .isEqualTo(HttpStatus.OK.value());
            SecurityContextHolder.clearContext();
        }
    }

    @Test
    void controlPlaneEndpoints_executorScope_areBlocked() throws Exception {
        record Call(String method, String uri) {}
        for (Call call : new Call[]{
                new Call("POST", "/api/transitions/assign"),
                new Call("POST", "/api/transitions/t-x/start"),
                new Call("POST", "/api/transitions/t-x/stop"),
                new Call("POST", "/api/transitions/t-x/fireOnce"),
                new Call("POST", "/api/transitions/t-x/credentials"),
                new Call("GET", "/api/transitions/t-x/credentials"),
                new Call("GET", "/api/transitions/t-x/status"),
                new Call("GET", "/api/executors"),
                new Call("GET", "/api/models"),
                new Call("POST", "/api/models"),
                new Call("GET", "/node-api/models"),
                new Call("PUT", "/vault-api/secrets")}) {
            authenticate("agenticos executor");
            MockHttpServletRequest req = request(call.method(), call.uri());
            MockHttpServletResponse res = new MockHttpServletResponse();
            FilterChain chain = mock(FilterChain.class);

            filter.doFilter(req, res, chain);

            verify(chain, never()).doFilter(req, res);
            assertThat(res.getStatus()).as("%s %s", call.method(), call.uri())
                    .isEqualTo(HttpStatus.FORBIDDEN.value());
            assertThat(res.getContentAsString()).contains("executor_scope");
            SecurityContextHolder.clearContext();
        }
    }

    @Test
    void adminScope_passesThroughUntouched() throws Exception {
        authenticate("agenticos admin");
        MockHttpServletRequest req = request("POST", "/api/transitions/assign");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void readonlyScope_passesThroughUntouched() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("GET", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
    }

    @Test
    void noAuthentication_passesThrough() throws Exception {
        MockHttpServletRequest req = request("POST", "/api/transitions/assign");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
    }

    @Test
    void lookAlikeScopeContainingExecutorSubstring_isNotTreatedAsExecutor() throws Exception {
        authenticate("agenticos executorplus");
        MockHttpServletRequest req = request("POST", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void deploymentPathTraversalLookAlike_isBlocked() throws Exception {
        // The {transitionId}/deployment allowance must not match nested paths.
        authenticate("agenticos executor");
        MockHttpServletRequest req = request("POST", "/api/transitions/t-x/credentials/deployment");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
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
