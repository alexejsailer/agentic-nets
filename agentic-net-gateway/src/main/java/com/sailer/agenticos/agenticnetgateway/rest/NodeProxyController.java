package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.publisher.Flux;

import java.io.IOException;
import java.time.Duration;
import java.util.Enumeration;
import java.util.Set;

/**
 * Catch-all reverse proxy — routes all /node-api/** requests to agentic-net-node.
 *
 * Maps: /node-api/foo/bar → agentic-net-node:8080/api/foo/bar
 * Strips the Authorization header since node has no auth.
 */
@RestController
@RequestMapping("/node-api")
public class NodeProxyController {

    private static final Logger logger = LoggerFactory.getLogger(NodeProxyController.class);

    private static final Set<String> HOP_BY_HOP = Set.of(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade", "host"
    );

    private final RestClient restClient;
    private final org.springframework.web.reactive.function.client.WebClient webClient;
    private final GatewayProperties props;

    public NodeProxyController(GatewayProperties props) {
        this.props = props;

        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        factory.setReadTimeout(Duration.ofSeconds(props.getProxyTimeoutSeconds()));
        this.restClient = RestClient.builder()
                .baseUrl(props.getNodeUrl())
                .requestFactory(factory)
                .build();

        this.webClient = org.springframework.web.reactive.function.client.WebClient.builder()
                .baseUrl(props.getNodeUrl())
                .codecs(c -> c.defaultCodecs().maxInMemorySize(10 * 1024 * 1024))
                .build();
    }

    /**
     * SSE streaming proxy — bridges node's SSE response to the client.
     */
    @RequestMapping(value = "/**", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter proxySse(HttpServletRequest request) {
        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;

        logger.debug("SSE node proxy: {} {}", request.getMethod(), uri);

        SseEmitter emitter = new SseEmitter(props.getProxyTimeoutSeconds() * 1000L);

        var webRequest = webClient.get().uri(uri)
                .accept(MediaType.TEXT_EVENT_STREAM);

        Flux<String> flux = webRequest
                .retrieve()
                .bodyToFlux(String.class);

        flux.subscribe(
                data -> {
                    try {
                        emitter.send(SseEmitter.event().data(data));
                    } catch (IOException e) {
                        emitter.completeWithError(e);
                    }
                },
                emitter::completeWithError,
                emitter::complete
        );

        return emitter;
    }

    /**
     * Catch-all REST proxy — forwards method, headers, query, body to node.
     */
    @RequestMapping(value = "/**")
    public ResponseEntity<byte[]> proxyRest(
            HttpServletRequest request,
            @RequestBody(required = false) byte[] body) {

        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        logger.debug("REST node proxy: {} {}", method, uri);

        try {
            var spec = restClient.method(method).uri(uri);

            HttpHeaders headers = copyHeaders(request);
            headers.forEach((name, values) -> values.forEach(v -> spec.header(name, v)));

            if (body != null && body.length > 0) {
                String contentType = request.getContentType();
                if (contentType != null) {
                    spec.contentType(MediaType.parseMediaType(contentType));
                }
                spec.body(body);
            }

            return spec.exchange((req, res) -> {
                byte[] responseBody = res.getBody().readAllBytes();
                HttpHeaders responseHeaders = new HttpHeaders();
                res.getHeaders().forEach((name, values) -> {
                    if (!HOP_BY_HOP.contains(name.toLowerCase())) {
                        responseHeaders.put(name, values);
                    }
                });
                return ResponseEntity.status(res.getStatusCode())
                        .headers(responseHeaders)
                        .body(responseBody);
            });
        } catch (HttpClientErrorException | HttpServerErrorException e) {
            return ResponseEntity.status(e.getStatusCode())
                    .headers(e.getResponseHeaders())
                    .body(e.getResponseBodyAsByteArray());
        } catch (Exception e) {
            logger.error("Node proxy error for {} {}: {}", method, uri, e.getMessage());
            return ResponseEntity.status(502)
                    .body(("{\"error\":\"Gateway error: " + e.getMessage() + "\"}").getBytes());
        }
    }

    /**
     * Extracts the downstream path: /node-api/foo/bar → /api/foo/bar
     */
    private String extractPath(HttpServletRequest request) {
        String uri = request.getRequestURI();
        // Replace /node-api with /api for downstream node
        if (uri.startsWith("/node-api")) {
            return "/api" + uri.substring("/node-api".length());
        }
        return uri;
    }

    private HttpHeaders copyHeaders(HttpServletRequest request) {
        HttpHeaders headers = new HttpHeaders();
        Enumeration<String> names = request.getHeaderNames();
        while (names.hasMoreElements()) {
            String name = names.nextElement();
            // Strip hop-by-hop AND authorization (node has no auth)
            if (!HOP_BY_HOP.contains(name.toLowerCase())
                    && !"authorization".equalsIgnoreCase(name)) {
                Enumeration<String> values = request.getHeaders(name);
                while (values.hasMoreElements()) {
                    headers.add(name, values.nextElement());
                }
            }
        }
        return headers;
    }
}
