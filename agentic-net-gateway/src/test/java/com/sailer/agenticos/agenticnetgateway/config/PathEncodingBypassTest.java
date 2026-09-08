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
import static org.mockito.Mockito.verify;

/**
 * Regression test for the percent-encoded path bypass of the gateway scope filters and the
 * token rate limiter.
 *
 * <p>Before the fix the filters classified the request on the raw {@code getRequestURI()}, so
 * {@code /%61pi/...} ("api" with an encoded 'a') was seen as "not an API path", skipped scope
 * enforcement, and still reached {@code /api/...} on the backend (Tomcat decodes the forwarded
 * URI). These tests assert that the encoded form is now treated identically to the plain form.</p>
 */
class PathEncodingBypassTest {

    private final ReadonlyEnforcementFilter readonly = new ReadonlyEnforcementFilter();
    private final ExecutorScopeEnforcementFilter executor = new ExecutorScopeEnforcementFilter();

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void readonly_encodedApiPrefix_isStillFiltered_andRejected() throws Exception {
        // shouldNotFilter must not skip the encoded API path.
        assertThat(readonly.shouldNotFilter(request("DELETE", "/%61pi/zz-probe"))).isFalse();

        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("DELETE", "/%61pi/zz-probe");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        readonly.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
        assertThat(res.getContentAsString()).contains("readonly_scope");
    }

    @Test
    void readonly_encodedSettingsWrite_isRejected() throws Exception {
        authenticate("agenticos readonly");
        MockHttpServletRequest req = request("PUT", "/%61pi/settings/zz-probe");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        readonly.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
    }

    @Test
    void executor_encodedApiPrefix_isStillFiltered_andRejected() throws Exception {
        assertThat(executor.shouldNotFilter(request("DELETE", "/%61pi/zz-probe"))).isFalse();

        authenticate("agenticos executor");
        MockHttpServletRequest req = request("DELETE", "/%61pi/zz-probe");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        executor.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
        assertThat(res.getContentAsString()).contains("executor_scope");
    }

    @Test
    void executor_encodedNonProtocolPost_isRejected() throws Exception {
        // /api/transitions/poll is allowed for executors, but an encoded reach at another route
        // (e.g. credentials) must not slip through.
        authenticate("agenticos executor");
        MockHttpServletRequest req = request("POST", "/%61pi/transitions/t-x/credentials");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        executor.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());
    }

    @Test
    void rateLimiter_encodedTokenEndpoint_isStillLimited() {
        TokenRateLimiter limiter = new TokenRateLimiter(new GatewayProperties());
        // The encoded token path must NOT be skipped by the limiter.
        assertThat(limiter.shouldNotFilter(request("POST", "/oauth2/t%6Fken"))).isFalse();
        assertThat(limiter.shouldNotFilter(request("POST", "/oauth2/token"))).isFalse();
        // A genuinely unrelated path is still skipped.
        assertThat(limiter.shouldNotFilter(request("POST", "/api/models"))).isTrue();
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
