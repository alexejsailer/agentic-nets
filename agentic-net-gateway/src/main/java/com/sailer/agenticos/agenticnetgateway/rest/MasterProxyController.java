package com.sailer.agenticos.agenticnetgateway.rest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService.MasterNode;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService.NoMasterAvailableException;
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
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Catch-all reverse proxy — routes /api/** requests to the correct master based on
 * model-to-master routing from {@link MasterRegistryService}.
 *
 * <p><b>modelId extraction</b> (checked in order):</p>
 * <ol>
 *   <li>Query param {@code modelId}</li>
 *   <li>Request body JSON field {@code modelId}</li>
 *   <li>Fallback: first active master</li>
 * </ol>
 *
 * <p><b>Special routes</b>:</p>
 * <ul>
 *   <li>{@code /api/transitions/discover} — fan-out to all relevant masters, aggregate results</li>
 *   <li>{@code /api/executors} (no modelId) — fan-out to all masters, aggregate executor lists</li>
 * </ul>
 */
@RestController
@RequestMapping("/api")
public class MasterProxyController {

    private static final Logger logger = LoggerFactory.getLogger(MasterProxyController.class);
    private static final ObjectMapper mapper = new ObjectMapper();

    private static final Set<String> HOP_BY_HOP = Set.of(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade", "host"
    );

    private static final Set<String> RESPONSE_ONLY_EXCLUDE = Set.of(
            "access-control-allow-origin", "access-control-allow-methods",
            "access-control-allow-headers", "access-control-allow-credentials",
            "access-control-expose-headers", "access-control-max-age"
    );

    private static final Set<String> REQUEST_ONLY_EXCLUDE = Set.of(
            "content-length", "content-type"
    );

    private final MasterRegistryService registryService;
    private final GatewayProperties props;

    /** Cached WebClients per master URL. */
    private final ConcurrentHashMap<String, WebClient> webClients = new ConcurrentHashMap<>();

    public MasterProxyController(GatewayProperties props, MasterRegistryService registryService) {
        this.props = props;
        this.registryService = registryService;
    }

    private WebClient getOrCreateClient(String baseUrl) {
        return webClients.computeIfAbsent(baseUrl, url ->
                WebClient.builder()
                        .baseUrl(url)
                        .codecs(c -> c.defaultCodecs().maxInMemorySize(10 * 1024 * 1024))
                        .build());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // SSE proxy
    // ──────────────────────────────────────────────────────────────────────────

    @RequestMapping(value = "/**", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter proxySse(HttpServletRequest request,
                               @RequestBody(required = false) byte[] body) {
        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        String modelId = extractModelId(request, body);
        MasterNode master;
        try {
            master = registryService.resolveMasterForModel(modelId);
        } catch (NoMasterAvailableException e) {
            logger.warn("SSE proxy: no master available for modelId={}: {}", modelId, e.getMessage());
            SseEmitter emitter = new SseEmitter(0L);
            emitter.completeWithError(e);
            return emitter;
        }

        logger.debug("SSE proxy: {} {} -> {}", method, uri, master.masterId());

        SseEmitter emitter = new SseEmitter(props.getProxyTimeoutSeconds() * 1000L);
        WebClient client = getOrCreateClient(master.url());

        WebClient.RequestHeadersSpec<?> spec = buildWebClientSpec(client, method, uri, body, request);

        Flux<String> flux = spec
                .accept(MediaType.TEXT_EVENT_STREAM)
                .retrieve()
                .bodyToFlux(String.class);

        flux.subscribe(
                data -> {
                    try {
                        emitter.send(SseEmitter.event().data(data));
                    } catch (IOException e) {
                        logger.debug("SSE send failed (client likely disconnected): {}", e.getMessage());
                        emitter.completeWithError(e);
                    }
                },
                emitter::completeWithError,
                emitter::complete
        );

        return emitter;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // REST proxy — with model-based routing and fan-out
    // ──────────────────────────────────────────────────────────────────────────

    @RequestMapping(value = "/**")
    public Mono<ResponseEntity<byte[]>> proxyRest(
            HttpServletRequest request,
            @RequestBody(required = false) byte[] body) {

        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        // Special: discover needs fan-out to all relevant masters
        if (path.startsWith("/api/transitions/discover")) {
            return handleDiscoverFanOut(request, body, uri, method);
        }

        // Special: executor listing may need fan-out if no modelId specified
        if (path.startsWith("/api/executors") && extractModelId(request, body) == null) {
            return handleExecutorListFanOut(request, body, uri, method);
        }

        // Standard: route to single master based on modelId
        String modelId = extractModelId(request, body);
        MasterNode master;
        try {
            master = registryService.resolveMasterForModel(modelId);
        } catch (NoMasterAvailableException e) {
            logger.error("No master available for modelId={}: {}", modelId, e.getMessage());
            return Mono.just(ResponseEntity.status(502)
                    .body(("{\"error\":\"No master available for model: " + modelId + "\"}").getBytes()));
        }

        logger.debug("REST proxy: {} {} -> {} (modelId={})", method, uri, master.masterId(), modelId);
        return proxyToMaster(master.url(), request, body, uri, method);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Fan-out: discover
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Fan-out discover to all relevant masters based on allowedModels query param.
     * Aggregates all {@code assignments} arrays into a unified response.
     */
    private Mono<ResponseEntity<byte[]>> handleDiscoverFanOut(
            HttpServletRequest request, byte[] body, String uri, HttpMethod method) {

        String allowedModels = request.getParameter("allowedModels");
        List<String> models = allowedModels != null
                ? Arrays.asList(allowedModels.split(","))
                : List.of("*");

        List<MasterNode> targets = registryService.mastersForModels(models);
        logger.debug("Discover fan-out to {} masters for models={}", targets.size(), models);

        if (targets.isEmpty()) {
            return Mono.just(ResponseEntity.status(502)
                    .body("{\"error\":\"No masters available\"}".getBytes()));
        }

        // If only one master, just proxy directly
        if (targets.size() == 1) {
            return proxyToMaster(targets.get(0).url(), request, body, uri, method);
        }

        Duration timeout = Duration.ofSeconds(props.getProxyFanOutTimeoutSeconds());

        List<Mono<ResponseEntity<byte[]>>> calls = targets.stream()
                .map(master -> proxyToMaster(master.url(), request, body, uri, method)
                        .timeout(timeout)
                        .onErrorResume(e -> {
                            logger.warn("Discover fan-out error from {}: {}", master.masterId(), e.getMessage());
                            return Mono.just(ResponseEntity.status(502)
                                    .body(("{\"error\":\"Upstream error from " + master.masterId() + ": " + e.getMessage() + "\"}").getBytes()));
                        }))
                .toList();

        return Flux.merge(calls)
                .collectList()
                .map(this::aggregateDiscoverResponses);
    }

    private ResponseEntity<byte[]> aggregateDiscoverResponses(List<ResponseEntity<byte[]>> responses) {
        try {
            ObjectNode merged = mapper.createObjectNode();
            ArrayNode allAssignments = mapper.createArrayNode();
            String executorId = null;

            for (ResponseEntity<byte[]> resp : responses) {
                if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null && resp.getBody().length > 0) {
                    JsonNode json = mapper.readTree(resp.getBody());
                    if (json.has("assignments")) {
                        for (JsonNode assignment : json.get("assignments")) {
                            allAssignments.add(assignment);
                        }
                    }
                    if (executorId == null && json.has("executorId")) {
                        executorId = json.get("executorId").asText();
                    }
                }
            }

            if (executorId != null) {
                merged.put("executorId", executorId);
            }
            merged.set("assignments", allAssignments);

            return ResponseEntity.ok()
                    .header("Content-Type", "application/json")
                    .body(mapper.writeValueAsBytes(merged));
        } catch (Exception e) {
            logger.error("Failed to aggregate discover responses: {}", e.getMessage());
            return ResponseEntity.status(502)
                    .body(("{\"error\":\"Aggregation failed: " + e.getMessage() + "\"}").getBytes());
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Fan-out: executor list
    // ──────────────────────────────────────────────────────────────────────────

    private Mono<ResponseEntity<byte[]>> handleExecutorListFanOut(
            HttpServletRequest request, byte[] body, String uri, HttpMethod method) {

        List<MasterNode> targets = registryService.getActiveMasters();

        if (targets.isEmpty()) {
            return Mono.just(ResponseEntity.status(502)
                    .body("{\"error\":\"No masters available\"}".getBytes()));
        }

        if (targets.size() == 1) {
            return proxyToMaster(targets.get(0).url(), request, body, uri, method);
        }

        Duration timeout = Duration.ofSeconds(props.getProxyFanOutTimeoutSeconds());

        List<Mono<ResponseEntity<byte[]>>> calls = targets.stream()
                .map(master -> proxyToMaster(master.url(), request, body, uri, method)
                        .timeout(timeout)
                        .onErrorResume(e -> {
                            logger.warn("Executor list fan-out error from {}: {}", master.masterId(), e.getMessage());
                            return Mono.just(ResponseEntity.status(502)
                                    .body(("{\"error\":\"Upstream error from " + master.masterId() + ": " + e.getMessage() + "\"}").getBytes()));
                        }))
                .toList();

        return Flux.merge(calls)
                .collectList()
                .map(this::aggregateArrayResponses);
    }

    private ResponseEntity<byte[]> aggregateArrayResponses(List<ResponseEntity<byte[]>> responses) {
        try {
            ArrayNode merged = mapper.createArrayNode();
            Set<String> seenIds = new HashSet<>();

            for (ResponseEntity<byte[]> resp : responses) {
                if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null && resp.getBody().length > 0) {
                    JsonNode json = mapper.readTree(resp.getBody());
                    if (json.isArray()) {
                        for (JsonNode item : json) {
                            String id = item.has("executorId") ? item.get("executorId").asText() : null;
                            if (id == null || seenIds.add(id)) {
                                merged.add(item);
                            }
                        }
                    }
                }
            }

            return ResponseEntity.ok()
                    .header("Content-Type", "application/json")
                    .body(mapper.writeValueAsBytes(merged));
        } catch (Exception e) {
            logger.error("Failed to aggregate executor list responses: {}", e.getMessage());
            return ResponseEntity.status(502)
                    .body(("{\"error\":\"Aggregation failed: " + e.getMessage() + "\"}").getBytes());
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Core proxy logic
    // ──────────────────────────────────────────────────────────────────────────

    private Mono<ResponseEntity<byte[]>> proxyToMaster(
            String masterUrl, HttpServletRequest request, byte[] body,
            String uri, HttpMethod method) {

        WebClient client = getOrCreateClient(masterUrl);
        WebClient.RequestHeadersSpec<?> spec = buildWebClientSpec(client, method, uri, body, request);

        return spec
                .exchangeToMono(response ->
                        response.bodyToMono(byte[].class)
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
                                }))
                .timeout(Duration.ofSeconds(props.getProxyTimeoutSeconds()))
                .onErrorResume(error -> {
                    logger.error("Proxy error for {} {} -> {}: {}", method, uri, masterUrl, error.getMessage());
                    return Mono.just(ResponseEntity.status(502)
                            .body(("{\"error\":\"Gateway error: " + error.getMessage() + "\"}").getBytes()));
                });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // modelId extraction
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Extract modelId from request. Checks (in order):
     * <ol>
     *   <li>Query parameter {@code modelId}</li>
     *   <li>JSON body field {@code modelId}</li>
     *   <li>Returns null (caller decides fallback)</li>
     * </ol>
     */
    private String extractModelId(HttpServletRequest request, byte[] body) {
        // 1. Query param
        String modelId = request.getParameter("modelId");
        if (modelId != null && !modelId.isBlank()) {
            return modelId;
        }

        // 2. Request body JSON field
        if (body != null && body.length > 0) {
            try {
                JsonNode json = mapper.readTree(body);
                if (json.has("modelId") && !json.get("modelId").isNull()) {
                    String bodyModelId = json.get("modelId").asText();
                    if (!bodyModelId.isBlank()) {
                        return bodyModelId;
                    }
                }
            } catch (Exception e) {
                logger.debug("Failed to parse request body as JSON for modelId extraction: {}", e.getMessage());
            }
        }

        return null;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────────

    private WebClient.RequestHeadersSpec<?> buildWebClientSpec(
            WebClient client, HttpMethod method, String uri, byte[] body,
            HttpServletRequest request) {

        HttpHeaders forwardHeaders = copyHeaders(request);

        if (body != null && body.length > 0) {
            String contentType = request.getContentType();
            var bodySpec = client.method(method).uri(uri);
            if (contentType != null) {
                bodySpec.contentType(MediaType.parseMediaType(contentType));
            }
            forwardHeaders.forEach((name, values) -> values.forEach(v -> bodySpec.header(name, v)));
            return bodySpec.bodyValue(body);
        } else {
            var getSpec = client.method(method).uri(uri);
            forwardHeaders.forEach((name, values) -> values.forEach(v -> getSpec.header(name, v)));
            return getSpec;
        }
    }

    private String extractPath(HttpServletRequest request) {
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
