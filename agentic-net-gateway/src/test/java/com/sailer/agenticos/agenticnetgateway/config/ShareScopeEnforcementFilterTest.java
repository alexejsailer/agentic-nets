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
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * Pins the share-scope containment contract.
 *
 * <p>This is the only credential in the system that is handed to anonymous strangers, so the
 * blast radius of a leaked one has to stay at "can look at one net". In particular
 * {@code GET /api/transitions/{id}/credentials} returns plaintext secrets and lives one path
 * segment away from endpoints this scope legitimately needs.</p>
 *
 * <p>Scoping is by NAME, not by member list: the token says which model/session/net/container it
 * may read, and the server resolves which places and transitions those contain. The tests below
 * therefore care about two things — that the named net is enforced exactly, and that a caller
 * cannot smuggle in its own member filter alongside it.</p>
 */
class ShareScopeEnforcementFilterTest {

    private static final String MODEL = "safe-teams";
    private static final String SESSION = "session-2026-08-22";
    private static final String NET = "net-forum";
    private static final String CONTAINER = "2f1c9d5e-0b3a-4c7d-8e91-6a5b4c3d2e1f";

    private final ShareScopeEnforcementFilter filter = new ShareScopeEnforcementFilter();

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void shouldNotFilter_passesForUnrelatedPaths() {
        assertThat(filter.shouldNotFilter(request("POST", "/oauth2/share"))).isTrue();
        assertThat(filter.shouldNotFilter(request("GET", "/actuator/health"))).isTrue();
        assertThat(filter.shouldNotFilter(request("GET", "/api/pnml/m/c"))).isFalse();
        assertThat(filter.shouldNotFilter(request("GET", "/node-api/models"))).isFalse();
    }

    @Test
    void viewerEndpoints_forTheClaimedNet_areAllowed() throws Exception {
        for (MockHttpServletRequest req : new MockHttpServletRequest[]{
                request("GET", "/api/pnml/" + MODEL + "/" + CONTAINER),
                netScoped("GET", "/api/models/" + MODEL + "/net-token-counts"),
                netScoped("GET", "/api/models/" + MODEL + "/execution/status"),
                netScoped("GET", "/api/event-line/" + MODEL),
                netScoped("GET", "/api/event-line/" + MODEL + "/stream")}) {
            authenticateShare(MODEL, "elements console");
            MockHttpServletResponse res = new MockHttpServletResponse();
            FilterChain chain = mock(FilterChain.class);

            filter.doFilter(req, res, chain);

            verify(chain, times(1)).doFilter(req, res);
            assertThat(res.getStatus()).as(req.getRequestURI()).isEqualTo(HttpStatus.OK.value());
            SecurityContextHolder.clearContext();
        }
    }

    @Test
    void foreignModel_isBlocked() throws Exception {
        for (MockHttpServletRequest req : new MockHttpServletRequest[]{
                request("GET", "/api/pnml/other-model/" + CONTAINER),
                netScoped("GET", "/api/models/other-model/net-token-counts"),
                netScoped("GET", "/api/models/other-model/execution/status"),
                netScoped("GET", "/api/event-line/other-model")}) {
            authenticateShare(MODEL, "console");
            assertRejected(req);
        }
    }

    @Test
    void foreignNetOrSession_isBlocked() throws Exception {
        // The named net IS the authorization. Renaming either half must not widen the link.
        record Call(String session, String net) {}
        for (Call call : new Call[]{
                new Call(SESSION, "net-private-sibling"),
                new Call("session-other", NET),
                new Call(SESSION, ""),
                new Call("", NET)}) {
            authenticateShare(MODEL, "console");
            MockHttpServletRequest req = request("GET", "/api/models/" + MODEL + "/execution/status");
            if (!call.session().isEmpty()) req.setParameter("netSessionId", call.session());
            if (!call.net().isEmpty()) req.setParameter("netId", call.net());
            assertRejected(req);
        }
    }

    @Test
    void aHandWrittenMemberFilter_alongsideTheNet_isBlocked() throws Exception {
        // Master would honour transitionId/transitionIds next to the net scope. Rather than
        // reason about which filter wins, refuse the request outright.
        for (String parameter : new String[]{"transitionId", "transitionIds"}) {
            for (String uri : new String[]{
                    "/api/models/" + MODEL + "/execution/status",
                    "/api/event-line/" + MODEL,
                    "/api/event-line/" + MODEL + "/stream"}) {
                authenticateShare(MODEL, "console");
                MockHttpServletRequest req = netScoped("GET", uri);
                req.setParameter(parameter, "t-private-sibling");
                assertRejected(req);
            }
        }
    }

    @Test
    void unscopedModelWideReads_areBlocked() throws Exception {
        // Omitting the net parameters must not fall back to the whole model.
        for (String uri : new String[]{
                "/api/models/" + MODEL + "/net-token-counts",
                "/api/models/" + MODEL + "/execution/status",
                "/api/event-line/" + MODEL,
                "/api/event-line/" + MODEL + "/stream"}) {
            authenticateShare(MODEL, "console");
            assertRejected(request("GET", uri));
        }
    }

    @Test
    void everythingElse_isBlocked_includingPlaintextCredentials() throws Exception {
        record Call(String method, String uri) {}
        for (Call call : new Call[]{
                // The one that matters most: plaintext secrets.
                new Call("GET", "/api/transitions/t-x/credentials"),
                new Call("GET", "/api/runtime/places"),
                new Call("POST", "/api/arcql/query/" + MODEL),
                new Call("POST", "/api/runtime/places/p-x/tokens/query"),
                new Call("GET", "/api/designtime/nets"),
                new Call("GET", "/api/models"),
                // Node's own count endpoints: the batch body cannot be authorized here, and the
                // per-path variant was replaced by the net-scoped counts route on master.
                new Call("POST", "/node-api/models/" + MODEL + "/children/count/batch"),
                new Call("GET", "/node-api/models/" + MODEL + "/children/count/by-path"),
                new Call("GET", "/node-api/models/" + MODEL + "/path/root/workspace/places"),
                new Call("GET", "/vault-api/secrets"),
                // Writes, even to an otherwise-allowed shape.
                new Call("POST", "/api/transitions/t-x/fireOnce"),
                new Call("DELETE", "/api/pnml/" + MODEL + "/" + CONTAINER),
                new Call("PUT", "/api/models/" + MODEL + "/execution/status")}) {
            authenticateShare(MODEL, "elements console");
            assertRejected(request(call.method(), call.uri()));
        }
    }

    @Test
    void activityFeed_requiresTheConsoleTabOnTheLink() throws Exception {
        for (String uri : new String[]{
                "/api/event-line/" + MODEL,
                "/api/event-line/" + MODEL + "/stream"}) {
            authenticateShare(MODEL, "elements");
            assertRejected(netScoped("GET", uri));

            authenticateShare(MODEL, "elements console");
            MockHttpServletRequest allowed = netScoped("GET", uri);
            MockHttpServletResponse res = new MockHttpServletResponse();
            FilterChain chain = mock(FilterChain.class);
            filter.doFilter(allowed, res, chain);
            verify(chain, times(1)).doFilter(allowed, res);
            assertThat(res.getStatus()).as("allowed %s", uri).isEqualTo(HttpStatus.OK.value());
            SecurityContextHolder.clearContext();
        }
    }

    @Test
    void missingModelClaim_isBlocked() throws Exception {
        Jwt jwt = Jwt.withTokenValue("test")
                .header("alg", "RS256")
                .subject("share:ref")
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .claim("scope", "agenticos share")
                .build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
        assertRejected(request("GET", "/api/pnml/" + MODEL + "/" + CONTAINER));
    }

    @Test
    void pnmlAllowance_matchesOnlyTheClaimedContainerUuid() throws Exception {
        // PnmlController hosts several routes of the same shape. Only the container-uuid export
        // is a single net; /sessions in particular lists every session in the model.
        for (String uri : new String[]{
                "/api/pnml/" + MODEL + "/sessions",
                "/api/pnml/" + MODEL + "/session-1/attempts",
                "/api/pnml/" + MODEL + "/" + CONTAINER + "/extra",
                "/api/pnml/" + MODEL + "/not-a-uuid",
                // A real uuid, but a different net's.
                "/api/pnml/" + MODEL + "/11111111-2222-3333-4444-555555555555"}) {
            authenticateShare(MODEL, "");
            assertRejected(request("GET", uri));
        }
    }

    @Test
    void adminAndReadonlyScopes_passThroughUntouched() throws Exception {
        for (String scope : new String[]{"agenticos admin", "agenticos readonly"}) {
            authenticateScope(scope);
            MockHttpServletRequest req = request("GET", "/api/transitions/t-x/credentials");
            MockHttpServletResponse res = new MockHttpServletResponse();
            FilterChain chain = mock(FilterChain.class);

            filter.doFilter(req, res, chain);

            verify(chain, times(1)).doFilter(req, res);
            SecurityContextHolder.clearContext();
        }
    }

    @Test
    void noAuthentication_passesThrough() throws Exception {
        // Anonymous traffic is this filter's blind spot BY DESIGN — SecurityConfig must never
        // permitAll anything under /api. This test documents that contract.
        MockHttpServletRequest req = request("GET", "/api/transitions/t-x/credentials");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
    }

    @Test
    void lookAlikeScopeContainingShareSubstring_isNotTreatedAsShare() throws Exception {
        authenticateScope("agenticos shareplus");
        MockHttpServletRequest req = request("GET", "/api/models");
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, times(1)).doFilter(req, res);
        assertThat(res.getStatus()).isEqualTo(HttpStatus.OK.value());
    }

    private void assertRejected(MockHttpServletRequest req) throws Exception {
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain, never()).doFilter(req, res);
        assertThat(res.getStatus()).as("%s %s", req.getMethod(), req.getRequestURI())
                .isEqualTo(HttpStatus.FORBIDDEN.value());
        assertThat(res.getContentAsString()).contains("share_scope");
        SecurityContextHolder.clearContext();
    }

    private static MockHttpServletRequest request(String method, String uri) {
        MockHttpServletRequest req = new MockHttpServletRequest(method, uri);
        req.setRequestURI(uri);
        return req;
    }

    /** A request naming the shared net the way the viewer does. */
    private static MockHttpServletRequest netScoped(String method, String uri) {
        MockHttpServletRequest req = request(method, uri);
        req.setParameter("netSessionId", SESSION);
        req.setParameter("netId", NET);
        return req;
    }

    private static void authenticateShare(String modelId, String tabs) {
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("scope", "agenticos share");
        claims.put("modelId", modelId);
        claims.put("sessionId", SESSION);
        claims.put("netId", NET);
        claims.put("containerId", CONTAINER);
        claims.put("tabs", tabs);
        authenticate(claims);
    }

    private static void authenticateScope(String scope) {
        authenticate(Map.of("scope", scope));
    }

    private static void authenticate(Map<String, Object> claims) {
        Jwt jwt = Jwt.withTokenValue("test")
                .header("alg", "RS256")
                .subject("test-subject")
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .claims(c -> c.putAll(claims))
                .build();
        Authentication auth = new JwtAuthenticationToken(jwt);
        SecurityContextHolder.getContext().setAuthentication(auth);
    }
}
