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
 * Reverse proxy for the optional on-device speech service (dictation and reading for Studio):
 * /speech-api/transcribe and /speech-api/speak go to {@code gateway.speech-url}
 * (deployment/speech/speech_service.py wraps whisper.cpp and Piper). Without a configured URL
 * every call answers 503 so Studio can say "no local speech service" instead of guessing.
 * The Authorization header is stripped: the service is local and unauthenticated.
 */
@RestController
@RequestMapping("/speech-api")
public class SpeechProxyController {

    private static final Logger logger = LoggerFactory.getLogger(SpeechProxyController.class);

    private static final Set<String> HOP_BY_HOP = Set.of(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade", "host"
    );

    private final RestClient restClient;
    private final GatewayProperties props;

    public SpeechProxyController(GatewayProperties props) {
        this.props = props;
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        // Transcribing a minute of speech on a laptop can take longer than a REST call.
        factory.setReadTimeout(Duration.ofSeconds(Math.max(props.getTimeoutSeconds(), 120)));
        this.restClient = RestClient.builder()
                .baseUrl(props.getSpeechUrl().isBlank() ? "http://127.0.0.1:0" : props.getSpeechUrl())
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

        if (props.getSpeechUrl() == null || props.getSpeechUrl().isBlank()) {
            return ResponseEntity.status(503).contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":\"no local speech service: set SPEECH_URL on the gateway (deployment/speech)\"}".getBytes());
        }
        String path = extractPath(request);
        String query = request.getQueryString();
        String uri = query != null ? path + "?" + query : path;
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        logger.debug("speech proxy: {} {}", method, uri);

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
            logger.error("Speech proxy error for {} {}: {}", method, uri, e.getMessage());
            return ResponseEntity.status(502)
                    .body(("{\"error\":\"Gateway error: " + e.getMessage() + "\"}").getBytes());
        }
    }

    /**
     * Extracts the downstream path: /vault-api/foo/bar → /api/foo/bar
     */
    private String extractPath(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri.startsWith("/speech-api")) {
            return uri.substring("/speech-api".length());
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
                    && !"authorization".equalsIgnoreCase(name)
                    && !name.toLowerCase().startsWith("x-agenticos-")) {
                Enumeration<String> values = request.getHeaders(name);
                while (values.hasMoreElements()) {
                    headers.add(name, values.nextElement());
                }
            }
        }
        com.sailer.agenticos.agenticnetgateway.config.ServiceAuth.apply(headers);
        return headers;
    }
}
