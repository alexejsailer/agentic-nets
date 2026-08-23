package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * Tests for {@link TokenRateLimiter} — the per-IP sliding-window throttle in front of {@code POST /oauth2/token}
 * that blunts credential brute-forcing. Untested, yet it's a security control: the count that triggers 429, the
 * per-IP isolation, and (critically) the {@code X-Forwarded-For} trust boundary all matter. The XFF cases guard
 * against a spoofing bypass — an attacker rotating a forged XFF header must NOT get a fresh bucket unless the
 * request actually arrived from a configured trusted proxy.
 */
class TokenRateLimiterTest {

    private GatewayProperties props(int limit, String trustedProxies) {
        GatewayProperties p = new GatewayProperties();
        p.setRateLimitPerMinute(limit);
        p.setTrustedProxies(trustedProxies);
        return p;
    }

    private MockHttpServletRequest tokenRequest(String remoteAddr, String xff) {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/oauth2/token");
        req.setRequestURI("/oauth2/token");
        req.setRemoteAddr(remoteAddr);
        if (xff != null) req.addHeader("X-Forwarded-For", xff);
        return req;
    }

    /** Fire one request; return the response so the caller can assert status/body. */
    private MockHttpServletResponse fire(TokenRateLimiter limiter, MockHttpServletRequest req, FilterChain chain)
            throws Exception {
        MockHttpServletResponse res = new MockHttpServletResponse();
        limiter.doFilter(req, res, chain);
        return res;
    }

    @Test
    void shouldNotFilter_onlyAppliesToTokenPost() {
        TokenRateLimiter limiter = new TokenRateLimiter(props(10, null));
        assertThat(limiter.shouldNotFilter(tokenRequest("1.2.3.4", null))).isFalse();
        MockHttpServletRequest share = new MockHttpServletRequest("POST", "/oauth2/share");
        share.setRequestURI("/oauth2/share");
        assertThat(limiter.shouldNotFilter(share)).isFalse();
        MockHttpServletRequest capabilityInPath = new MockHttpServletRequest("POST", "/oauth2/share/secret");
        capabilityInPath.setRequestURI("/oauth2/share/secret");
        assertThat(limiter.shouldNotFilter(capabilityInPath)).isTrue();
        MockHttpServletRequest get = new MockHttpServletRequest("GET", "/oauth2/token");
        get.setRequestURI("/oauth2/token");
        assertThat(limiter.shouldNotFilter(get)).isTrue();
        MockHttpServletRequest otherPost = new MockHttpServletRequest("POST", "/api/models");
        otherPost.setRequestURI("/api/models");
        assertThat(limiter.shouldNotFilter(otherPost)).isTrue();
    }

    @Test
    void requestsUnderTheLimitPassThrough() throws Exception {
        TokenRateLimiter limiter = new TokenRateLimiter(props(3, null));
        for (int i = 0; i < 3; i++) {
            FilterChain chain = mock(FilterChain.class);
            MockHttpServletResponse res = fire(limiter, tokenRequest("1.2.3.4", null), chain);
            verify(chain, times(1)).doFilter(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
            assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
        }
    }

    @Test
    void requestOverTheLimitIsBlockedWith429() throws Exception {
        TokenRateLimiter limiter = new TokenRateLimiter(props(2, null));
        // Exhaust the 2/min budget.
        fire(limiter, tokenRequest("9.9.9.9", null), mock(FilterChain.class));
        fire(limiter, tokenRequest("9.9.9.9", null), mock(FilterChain.class));

        FilterChain blockedChain = mock(FilterChain.class);
        MockHttpServletResponse res = fire(limiter, tokenRequest("9.9.9.9", null), blockedChain);

        assertThat(res.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS.value());
        assertThat(res.getHeader("Retry-After")).isEqualTo("60");
        assertThat(res.getContentAsString()).contains("rate_limit_exceeded");
        verify(blockedChain, never()).doFilter(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    void limitIsTrackedPerIpIndependently() throws Exception {
        TokenRateLimiter limiter = new TokenRateLimiter(props(1, null));
        // IP A uses its single allowance...
        fire(limiter, tokenRequest("10.0.0.5", null), mock(FilterChain.class));
        MockHttpServletResponse aBlocked = fire(limiter, tokenRequest("10.0.0.5", null), mock(FilterChain.class));
        assertThat(aBlocked.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS.value());

        // ...but IP B is unaffected and gets its own allowance.
        MockHttpServletResponse bOk = fire(limiter, tokenRequest("10.0.0.6", null), mock(FilterChain.class));
        assertThat(bOk.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void forwardedForIsIgnoredFromAnUntrustedRemoteAddr() throws Exception {
        // remoteAddr is NOT in trustedProxies, so a rotating XFF must not mint fresh buckets:
        // both requests count against the real remoteAddr and the second is blocked.
        TokenRateLimiter limiter = new TokenRateLimiter(props(1, "10.0.0.1"));
        fire(limiter, tokenRequest("9.9.9.9", "1.1.1.1"), mock(FilterChain.class));
        MockHttpServletResponse blocked = fire(limiter, tokenRequest("9.9.9.9", "2.2.2.2"), mock(FilterChain.class));
        assertThat(blocked.getStatus())
                .as("a spoofed X-Forwarded-For from an untrusted hop must not bypass the limit")
                .isEqualTo(HttpStatus.TOO_MANY_REQUESTS.value());
    }

    @Test
    void forwardedForIsHonoredFromATrustedProxy() throws Exception {
        // remoteAddr IS the trusted proxy, so the real client is the first XFF hop and each distinct client
        // gets its own bucket — but a repeat of the same client hits the limit.
        TokenRateLimiter limiter = new TokenRateLimiter(props(1, "10.0.0.1"));
        MockHttpServletResponse c1 = fire(limiter, tokenRequest("10.0.0.1", "1.1.1.1"), mock(FilterChain.class));
        MockHttpServletResponse c2 = fire(limiter, tokenRequest("10.0.0.1", "2.2.2.2"), mock(FilterChain.class));
        MockHttpServletResponse c1again = fire(limiter, tokenRequest("10.0.0.1", "1.1.1.1"), mock(FilterChain.class));

        assertThat(c1.getStatus()).isEqualTo(HttpStatus.OK.value());
        assertThat(c2.getStatus()).as("a different forwarded client is a different bucket").isEqualTo(HttpStatus.OK.value());
        assertThat(c1again.getStatus())
                .as("the same forwarded client is throttled on its second call")
                .isEqualTo(HttpStatus.TOO_MANY_REQUESTS.value());
    }
}
