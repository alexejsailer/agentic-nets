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

import java.time.Duration;
import java.util.Enumeration;
import java.util.Set;

/**
 * Reverse proxy — routes all /vault-api/** requests to agentic-net-vault.
 *
 * Maps: /vault-api/vault/{modelId}/transitions/{id}/credentials
 *     → agentic-net-vault:8085/api/vault/{modelId}/transitions/{id}/credentials
 *
 * Strips the Authorization header since vault uses its own token auth.
 */
@RestController
@RequestMapping("/vault-api")
public class VaultProxyController {

    private static final Logger logger = LoggerFactory.getLogger(VaultProxyController.class);

    private static final Set<String> HOP_BY_HOP = Set.of(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade", "host"
    );

    private final RestClient restClient;

    public VaultProxyController(GatewayProperties props) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        factory.setReadTimeout(Duration.ofSeconds(props.getTimeoutSeconds()));
        this.restClient = RestClient.builder()
                .baseUrl(props.getVaultUrl())
                .requestFactory(factory)
                .build();
    }

    /**
     * Catch-all REST proxy — forwards method, headers, query, body to vault.
     */
    @RequestMapping(value = "/**")
    public ResponseEntity<byte[]> proxyRest(
            HttpServletRequest request,
            @RequestBody(required = false) byte[] body) {

        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        logger.debug("REST vault proxy: {} {}", method, uri);

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
            logger.error("Vault proxy error for {} {}: {}", method, uri, e.getMessage());
            return ResponseEntity.status(502)
                    .body(("{\"error\":\"Gateway error: " + e.getMessage() + "\"}").getBytes());
        }
    }

    /**
     * Extracts the downstream path: /vault-api/foo/bar → /api/foo/bar
     */
    private String extractPath(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri.startsWith("/vault-api")) {
            return "/api" + uri.substring("/vault-api".length());
        }
        return uri;
    }

    private HttpHeaders copyHeaders(HttpServletRequest request) {
        HttpHeaders headers = new HttpHeaders();
        Enumeration<String> names = request.getHeaderNames();
        while (names.hasMoreElements()) {
            String name = names.nextElement();
            // Strip hop-by-hop AND authorization (vault uses its own token auth)
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
