package com.sailer.agenticos.agenticnetvault.config;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/** With a token configured the API requires X-Service-Auth; health stays open; unset = inert. */
class ServiceTokenFilterTest {

    @AfterEach
    void reset() { ServiceAuth.configure(null); }

    private static MockHttpServletRequest req(String method, String uri, String header) {
        MockHttpServletRequest r = new MockHttpServletRequest(method, uri);
        r.setRequestURI(uri);
        if (header != null) r.addHeader(ServiceAuth.HEADER, header);
        return r;
    }

    @Test
    void requiresTokenOnApi_whenConfigured() throws Exception {
        ServiceTokenFilter f = new ServiceTokenFilter("unit-token");
        assertFalse(f.shouldNotFilter(req("POST", "/api/vault/m/transitions/t/credentials", null)));
        FilterChain chain = mock(FilterChain.class);
        MockHttpServletResponse res = new MockHttpServletResponse();
        f.doFilter(req("POST", "/api/vault/m/transitions/t/credentials", null), res, chain);
        verify(chain, never()).doFilter(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        assertEquals(401, res.getStatus());
        assertTrue(res.getContentAsString().contains("service_auth_required"));
    }

    @Test
    void acceptsCorrectToken_rejectsWrongOne() throws Exception {
        ServiceTokenFilter f = new ServiceTokenFilter("unit-token");
        FilterChain ok = mock(FilterChain.class);
        MockHttpServletRequest good = req("POST", "/api/vault/m/transitions/t/credentials", "Bearer unit-token");
        MockHttpServletResponse res = new MockHttpServletResponse();
        f.doFilter(good, res, ok);
        verify(ok, times(1)).doFilter(good, res);
        FilterChain bad = mock(FilterChain.class);
        MockHttpServletResponse res2 = new MockHttpServletResponse();
        f.doFilter(req("POST", "/api/vault/m/transitions/t/credentials", "Bearer nope"), res2, bad);
        verify(bad, never()).doFilter(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        assertEquals(401, res2.getStatus());
    }

    @Test
    void healthAndPreflightStayOpen() {
        ServiceTokenFilter f = new ServiceTokenFilter("unit-token");
        assertTrue(f.shouldNotFilter(req("GET", "/actuator/health", null)));
        assertTrue(f.shouldNotFilter(req("GET", "/api/health", null)));
        assertTrue(f.shouldNotFilter(req("OPTIONS", "/api/vault/m/transitions/t/credentials", null)));
    }

    @Test
    void inertWhenNoTokenConfigured() {
        ServiceTokenFilter f = new ServiceTokenFilter("");
        assertTrue(f.shouldNotFilter(req("POST", "/api/vault/m/transitions/t/credentials", null)));
    }
}
