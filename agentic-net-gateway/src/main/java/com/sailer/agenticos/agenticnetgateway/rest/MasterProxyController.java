package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.io.IOException;
import java.time.Duration;
import java.util.Enumeration;
import java.util.Set;

/**
 * Catch-all reverse proxy — routes all /api/** requests (not handled by explicit controllers)
 * to agentic-net-master on the internal network.
 *
 * Spring MVC routes explicit controllers first, so /api/health/**
 * is handled locally; everything else is proxied here.
 *
 * Uses async WebClient for all proxy calls (both REST and SSE) to avoid
 * blocking issues with master's reactive (WebFlux) responses.
 */
@RestController
@RequestMapping("/api")
public class MasterProxyController {

    private static final Logger logger = LoggerFactory.getLogger(MasterProxyController.class);

    /** Headers never forwarded (neither request nor response). */
    private static final Set<String> HOP_BY_HOP = Set.of(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade", "host"
    );

    /** Response headers stripped to avoid duplication with gateway's own CORS filter. */
    private static final Set<String> RESPONSE_ONLY_EXCLUDE = Set.of(
            "access-control-allow-origin", "access-control-allow-methods",
            "access-control-allow-headers", "access-control-allow-credentials",
            "access-control-expose-headers", "access-control-max-age"
    );

    /** Additional headers excluded only from request forwarding.
     *  WebClient sets these from the body — duplicates cause WebFlux to hang. */
    private static final Set<String> REQUEST_ONLY_EXCLUDE = Set.of(
            "content-length", "content-type"
    );

    private final WebClient webClient;
    private final GatewayProperties props;

    public MasterProxyController(GatewayProperties props) {
        this.props = props;

        this.webClient = WebClient.builder()
                .baseUrl(props.getMasterUrl())
                .codecs(c -> c.defaultCodecs().maxInMemorySize(10 * 1024 * 1024))
                .build();
    }

    /**
     * SSE streaming proxy — bridges master's SSE response to the client.
     * Respects the original HTTP method (GET or POST) and forwards the body for POST.
     */
    @RequestMapping(value = "/**", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter proxySse(HttpServletRequest request,
                               @RequestBody(required = false) byte[] body) {
        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        logger.debug("SSE proxy: {} {}", method, uri);

        SseEmitter emitter = new SseEmitter(props.getProxyTimeoutSeconds() * 1000L);

        WebClient.RequestHeadersSpec<?> spec = buildWebClientSpec(method, uri, body, request);

        Flux<String> flux = spec
                .accept(MediaType.TEXT_EVENT_STREAM)
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
     * Catch-all REST proxy — forwards method, headers, query, body to master.
     * Uses async WebClient to avoid blocking on master's reactive responses.
     */
    @RequestMapping(value = "/**")
    public Mono<ResponseEntity<byte[]>> proxyRest(
            HttpServletRequest request,
            @RequestBody(required = false) byte[] body) {

        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        logger.debug("REST proxy: {} {}", method, uri);

        WebClient.RequestHeadersSpec<?> spec = buildWebClientSpec(method, uri, body, request);

        return spec
                .exchangeToMono(response -> {
                    return response.bodyToMono(byte[].class)
                            .defaultIfEmpty(new byte[0])
                            .map(responseBody -> {
                                HttpHeaders responseHeaders = new HttpHeaders();
                                response.headers().asHttpHeaders().forEach((name, values) -> {
                                    String lower = name.toLowerCase();
                                    if (!HOP_BY_HOP.contains(lower)
                                            && !RESPONSE_ONLY_EXCLUDE.contains(lower)) {
                                        responseHeaders.put(name, values);
                                    }
                                });
                                return ResponseEntity.status(response.statusCode())
                                        .headers(responseHeaders)
                                        .body(responseBody);
                            });
                })
                .timeout(Duration.ofSeconds(props.getProxyTimeoutSeconds()))
                .onErrorResume(error -> {
                    logger.error("Proxy error for {} {}: {}", method, uri, error.getMessage());
                    return Mono.just(ResponseEntity.status(502)
                            .body(("{\"error\":\"Gateway error: " + error.getMessage() + "\"}").getBytes()));
                });
    }

    /**
     * Build a WebClient request spec with forwarded headers and body.
     */
    private WebClient.RequestHeadersSpec<?> buildWebClientSpec(
            HttpMethod method, String uri, byte[] body, HttpServletRequest request) {

        HttpHeaders forwardHeaders = copyHeaders(request);

        if (body != null && body.length > 0) {
            String contentType = request.getContentType();
            var bodySpec = webClient.method(method).uri(uri);
            if (contentType != null) {
                bodySpec.contentType(MediaType.parseMediaType(contentType));
            }
            forwardHeaders.forEach((name, values) -> values.forEach(v -> bodySpec.header(name, v)));
            return bodySpec.bodyValue(body);
        } else {
            var getSpec = webClient.method(method).uri(uri);
            forwardHeaders.forEach((name, values) -> values.forEach(v -> getSpec.header(name, v)));
            return getSpec;
        }
    }

    private String extractPath(HttpServletRequest request) {
        // Request URI includes /api/..., forward as-is to master
        return request.getRequestURI();
    }

    private HttpHeaders copyHeaders(HttpServletRequest request) {
        HttpHeaders headers = new HttpHeaders();
        Enumeration<String> names = request.getHeaderNames();
        while (names.hasMoreElements()) {
            String name = names.nextElement();
            String lower = name.toLowerCase();
            if (!HOP_BY_HOP.contains(lower)
                    && !REQUEST_ONLY_EXCLUDE.contains(lower)
                    && !"authorization".equalsIgnoreCase(name)) { // Don't forward JWT to master
                Enumeration<String> values = request.getHeaders(name);
                while (values.hasMoreElements()) {
                    headers.add(name, values.nextElement());
                }
            }
        }
        return headers;
    }
}
