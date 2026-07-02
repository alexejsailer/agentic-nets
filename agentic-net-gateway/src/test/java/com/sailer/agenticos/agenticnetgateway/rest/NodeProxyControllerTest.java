package com.sailer.agenticos.agenticnetgateway.rest;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Hermetic unit tests for {@link NodeProxyController}.
 *
 * <p>The controller is constructed directly (no Spring context) against a WireMock
 * server standing in for agentic-net-node. Requests are simulated with
 * {@link MockHttpServletRequest} and {@code proxyRest(...)} is invoked directly, so
 * these tests verify the real proxy logic:</p>
 * <ul>
 *   <li>path rewrite {@code /node-api/**} → {@code /api/**}</li>
 *   <li>hop-by-hop header stripping + Authorization stripping (node has no auth)</li>
 *   <li>query-string and request-body forwarding</li>
 *   <li>downstream status + response-header passthrough</li>
 *   <li>502 when node is unreachable</li>
 * </ul>
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class NodeProxyControllerTest {

    private WireMockServer node;
    private NodeProxyController controller;

    @BeforeAll
    void startNode() {
        node = new WireMockServer(0); // random port
        node.start();

        GatewayProperties props = new GatewayProperties();
        props.setNodeUrl("http://localhost:" + node.port());
        controller = new NodeProxyController(props);
    }

    @AfterAll
    void stopNode() {
        if (node != null) {
            node.stop();
        }
    }

    @BeforeEach
    void resetNode() {
        node.resetAll();
    }

    private MockHttpServletRequest req(String method, String uri) {
        MockHttpServletRequest r = new MockHttpServletRequest();
        r.setMethod(method);
        r.setRequestURI(uri);
        return r;
    }

    // ── Path rewrite ──────────────────────────────────────────────────────────

    @Test
    void proxyRest_rewritesNodeApiPrefixToApi() {
        node.stubFor(get(urlPathEqualTo("/api/models/foo"))
                .willReturn(okJson("{\"ok\":true}")));

        ResponseEntity<byte[]> resp = controller.proxyRest(req("GET", "/node-api/models/foo"), null);

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        assertThat(new String(resp.getBody(), StandardCharsets.UTF_8)).contains("\"ok\":true");
        // The downstream path must be /api/... — never /node-api/...
        node.verify(getRequestedFor(urlPathEqualTo("/api/models/foo")));
    }

    // ── Authorization stripping (node has no auth) ──────────────────────────────

    @Test
    void proxyRest_stripsAuthorizationHeader() {
        node.stubFor(get(urlPathEqualTo("/api/secure")).willReturn(okJson("{}")));

        MockHttpServletRequest request = req("GET", "/node-api/secure");
        request.addHeader("Authorization", "Bearer super-secret-token");

        ResponseEntity<byte[]> resp = controller.proxyRest(request, null);

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        // The Authorization header must NOT reach node.
        node.verify(getRequestedFor(urlPathEqualTo("/api/secure"))
                .withHeader("Authorization", absent()));
    }

    // ── Hop-by-hop stripping ────────────────────────────────────────────────────

    @Test
    void proxyRest_stripsHopByHopRequestHeaders() {
        node.stubFor(get(urlPathEqualTo("/api/hop")).willReturn(okJson("{}")));

        MockHttpServletRequest request = req("GET", "/node-api/hop");
        request.addHeader("Proxy-Authorization", "Basic abc"); // hop-by-hop
        request.addHeader("TE", "trailers");                    // hop-by-hop

        controller.proxyRest(request, null);

        node.verify(getRequestedFor(urlPathEqualTo("/api/hop"))
                .withHeader("Proxy-Authorization", absent())
                .withHeader("TE", absent()));
    }

    // ── Custom header + query forwarding ────────────────────────────────────────

    @Test
    void proxyRest_forwardsCustomHeaders() {
        node.stubFor(get(urlPathEqualTo("/api/withheader")).willReturn(okJson("{}")));

        MockHttpServletRequest request = req("GET", "/node-api/withheader");
        request.addHeader("X-Correlation-Id", "corr-42");

        controller.proxyRest(request, null);

        node.verify(getRequestedFor(urlPathEqualTo("/api/withheader"))
                .withHeader("X-Correlation-Id", equalTo("corr-42")));
    }

    @Test
    void proxyRest_forwardsQueryString() {
        node.stubFor(get(urlEqualTo("/api/search?q=test&limit=5"))
                .willReturn(okJson("{\"hits\":0}")));

        MockHttpServletRequest request = req("GET", "/node-api/search");
        request.setQueryString("q=test&limit=5");

        ResponseEntity<byte[]> resp = controller.proxyRest(request, null);

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        node.verify(getRequestedFor(urlEqualTo("/api/search?q=test&limit=5")));
    }

    // ── POST body forwarding ────────────────────────────────────────────────────

    @Test
    void proxyRest_forwardsPostBody() {
        node.stubFor(post(urlPathEqualTo("/api/events"))
                .willReturn(aResponse().withStatus(201).withBody("created")));

        MockHttpServletRequest request = req("POST", "/node-api/events");
        request.setContentType("application/json");
        byte[] body = "{\"name\":\"e1\"}".getBytes(StandardCharsets.UTF_8);

        ResponseEntity<byte[]> resp = controller.proxyRest(request, body);

        assertThat(resp.getStatusCode().value()).isEqualTo(201);
        assertThat(new String(resp.getBody(), StandardCharsets.UTF_8)).isEqualTo("created");
        node.verify(postRequestedFor(urlPathEqualTo("/api/events"))
                .withRequestBody(equalToJson("{\"name\":\"e1\"}")));
    }

    @Test
    void proxyRest_emptyBodyIsNotForwardedAsContent() {
        node.stubFor(post(urlPathEqualTo("/api/ping"))
                .willReturn(aResponse().withStatus(200)));

        MockHttpServletRequest request = req("POST", "/node-api/ping");

        ResponseEntity<byte[]> resp = controller.proxyRest(request, new byte[0]);

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        node.verify(postRequestedFor(urlPathEqualTo("/api/ping")));
    }

    // ── Downstream status + response header passthrough ─────────────────────────

    @Test
    void proxyRest_passesThroughNotFoundStatusAndBody() {
        node.stubFor(get(urlPathEqualTo("/api/missing"))
                .willReturn(aResponse().withStatus(404).withBody("{\"error\":\"not found\"}")));

        ResponseEntity<byte[]> resp = controller.proxyRest(req("GET", "/node-api/missing"), null);

        assertThat(resp.getStatusCode().value()).isEqualTo(404);
        assertThat(new String(resp.getBody(), StandardCharsets.UTF_8)).contains("not found");
    }

    @Test
    void proxyRest_passesThroughServerErrorStatus() {
        node.stubFor(get(urlPathEqualTo("/api/boom"))
                .willReturn(aResponse().withStatus(503).withBody("down")));

        ResponseEntity<byte[]> resp = controller.proxyRest(req("GET", "/node-api/boom"), null);

        assertThat(resp.getStatusCode().value()).isEqualTo(503);
        assertThat(new String(resp.getBody(), StandardCharsets.UTF_8)).isEqualTo("down");
    }

    @Test
    void proxyRest_forwardsResponseHeaders() {
        node.stubFor(get(urlPathEqualTo("/api/withresp"))
                .willReturn(okJson("{}").withHeader("X-Node-Version", "9.9")));

        ResponseEntity<byte[]> resp = controller.proxyRest(req("GET", "/node-api/withresp"), null);

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        assertThat(resp.getHeaders().getFirst("X-Node-Version")).isEqualTo("9.9");
    }

    // ── Failure mode: node unreachable ──────────────────────────────────────────

    @Test
    void proxyRest_returns502WhenNodeUnreachable() throws Exception {
        int deadPort;
        try (ServerSocket s = new ServerSocket(0)) {
            deadPort = s.getLocalPort();
        } // socket closed → nothing listening on deadPort

        GatewayProperties props = new GatewayProperties();
        props.setNodeUrl("http://localhost:" + deadPort);
        NodeProxyController down = new NodeProxyController(props);

        ResponseEntity<byte[]> resp = down.proxyRest(req("GET", "/node-api/anything"), null);

        assertThat(resp.getStatusCode().value()).isEqualTo(502);
        assertThat(new String(resp.getBody(), StandardCharsets.UTF_8)).contains("Gateway error");
    }
}
