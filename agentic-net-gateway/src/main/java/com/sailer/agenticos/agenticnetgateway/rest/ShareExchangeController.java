package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import com.sailer.agenticos.agenticnetgateway.config.ProxyWebClients;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Anonymous exchange for a read-only net share link.
 *
 * <p>{@code POST /oauth2/share} is the ONLY unauthenticated route this feature adds,
 * and it exists solely to convert the link secret into a short-lived, tightly scoped JWT. The
 * reason for the indirection: both {@code ReadonlyEnforcementFilter} and
 * {@code ExecutorScopeEnforcementFilter} return early when the request carries no JWT, and
 * {@code TokenRateLimiter} only guards the token endpoint. A route left simply {@code permitAll}
 * would therefore be constrained by nothing at all, one path segment away from
 * {@code GET /api/transitions/{id}/credentials}, which returns plaintext secrets. Trading the
 * uuid for a token puts the visitor back under
 * {@link com.sailer.agenticos.agenticnetgateway.config.ShareScopeEnforcementFilter}.</p>
 *
 * <p>The recipient of the link never sees any of this: they open a URL, nothing more.</p>
 *
 * <p>Gated by {@code gateway.share-enabled}. When off, the path is not whitelisted in
 * {@code SecurityConfig} and anonymous callers get 401 before reaching this controller.</p>
 */
@RestController
public class ShareExchangeController {

    private static final Logger logger = LoggerFactory.getLogger(ShareExchangeController.class);
    private static final String INTERNAL_SECRET_HEADER = "X-Agenticos-Internal-Secret";
    /** The share registry lives in the default model, alongside the package registry. */
    private static final String SHARE_REGISTRY_MODEL = "default";

    private final JwtEncoder jwtEncoder;
    private final GatewayProperties props;
    private final MasterRegistryService masterRegistry;
    private final WebClient webClient;

    public ShareExchangeController(JwtEncoder jwtEncoder, GatewayProperties props,
                                   MasterRegistryService masterRegistry) {
        this.jwtEncoder = jwtEncoder;
        this.props = props;
        this.masterRegistry = masterRegistry;
        this.webClient = ProxyWebClients.builder().build();
    }

    public record ShareExchangeRequest(String shareId) {}

    @PostMapping(value = "/oauth2/share", produces = MediaType.APPLICATION_JSON_VALUE)
    public Mono<ResponseEntity<Map<String, Object>>> exchange(
            @RequestBody(required = false) ShareExchangeRequest request) {
        if (!props.isShareEnabled()) {
            return Mono.just(notFound());
        }
        String shareId = request != null ? request.shareId() : null;
        if (shareId == null || shareId.isBlank()) {
            return Mono.just(notFound());
        }
        if (props.getInternalSecret() == null || props.getInternalSecret().isBlank()) {
            logger.error("Share exchange called but gateway internal secret is not configured");
            return Mono.just(ResponseEntity.status(503)
                    .body(Map.<String, Object>of("error", "server_not_configured")));
        }

        final String masterUrl;
        try {
            masterUrl = masterRegistry.resolveMasterForModel(SHARE_REGISTRY_MODEL).url();
        } catch (RuntimeException e) {
            logger.warn("Share exchange could not resolve a master: {}", e.getMessage());
            return Mono.just(ResponseEntity.status(503)
                    .body(Map.<String, Object>of("error", "no_master_available")));
        }

        return webClient.post()
                .uri(masterUrl + "/internal/shares/resolve")
                .header(INTERNAL_SECRET_HEADER, props.getInternalSecret())
                .bodyValue(Map.of("shareId", shareId))
                .retrieve()
                .bodyToMono(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(Duration.ofSeconds(props.getTimeoutSeconds()))
                .map(this::mintToken)
                // Unknown, expired and revoked all surface from master as 404 — deliberately
                // indistinguishable, so a caller cannot probe which. Anything else (master down,
                // malformed record) must not leak either, so it collapses here too.
                //
                // The one case that must NOT collapse is master's 503: it means the share store
                // could not be read this second, not that the link is finished. Relaying it lets
                // the page retry rather than telling a visitor their working link is revoked.
                // It still carries nothing about whether the link exists, so it leaks nothing.
                .onErrorResume(e -> {
                    if (e instanceof WebClientResponseException http
                            && http.getStatusCode() == HttpStatus.SERVICE_UNAVAILABLE) {
                        logger.info("Share exchange temporarily unavailable — asking the caller to retry");
                        return Mono.just(ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                                .body(Map.<String, Object>of("error", "share_unavailable",
                                        "retryable", true)));
                    }
                    logger.info("Share exchange refused for a link: {}", e.getMessage());
                    return Mono.just(notFound());
                });
    }

    private ResponseEntity<Map<String, Object>> mintToken(Map<String, Object> record) {
        String modelId = str(record.get("modelId"));
        String shareRef = str(record.get("shareRef"));
        String sessionId = str(record.get("sessionId"));
        String netId = str(record.get("netId"));
        String containerId = str(record.get("containerId"));
        if (modelId == null || shareRef == null || sessionId == null
                || netId == null || containerId == null) {
            return notFound();
        }

        List<String> tabs = toStringList(record.get("tabs"));
        Instant now = Instant.now();
        Instant tokenExpiry = now.plusSeconds(props.getShareTokenTtlSeconds());
        // Never outlive the link itself: a 15-minute token issued 5 minutes before the link
        // expires must die with the link, not 10 minutes after it.
        Instant linkExpiry = parseInstant(str(record.get("expiresAt")));
        if (linkExpiry != null && linkExpiry.isBefore(tokenExpiry)) {
            tokenExpiry = linkExpiry;
        }
        if (!tokenExpiry.isAfter(now)) {
            return notFound();
        }

        JwtClaimsSet.Builder claims = JwtClaimsSet.builder()
                .issuer("agenticos")
                .subject("share:" + shareRef)
                .issuedAt(now)
                .expiresAt(tokenExpiry)
                .claim("scope", "agenticos share")
                .claim("modelId", modelId)
                .claim("shareRef", shareRef)
                // Space-joined so the enforcement filter can test membership without JSON parsing.
                .claim("tabs", String.join(" ", tabs))
                // Session + net + container only. The place and transition members are
                // deliberately NOT embedded: this token is a request header, and a large net
                // would make every single call carry kilobytes of ids. The server resolves the
                // members from the net name on each request instead.
                .claim("sessionId", sessionId)
                .claim("netId", netId)
                .claim("containerId", containerId);

        String jwt = jwtEncoder.encode(JwtEncoderParameters.from(claims.build())).getTokenValue();
        long expiresIn = Duration.between(now, tokenExpiry).getSeconds();

        logger.info("Share token issued ref={} model={} net={} ttl={}s",
                shareRef, modelId, str(record.get("netId")), expiresIn);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("access_token", jwt);
        body.put("token_type", "Bearer");
        body.put("expires_in", expiresIn);
        body.put("scope", "agenticos share");
        body.put("modelId", modelId);
        body.put("sessionId", record.get("sessionId"));
        body.put("netId", record.get("netId"));
        body.put("containerId", record.get("containerId"));
        body.put("label", record.get("label"));
        body.put("tabs", tabs);
        body.put("expiresAt", record.get("expiresAt"));
        return ResponseEntity.ok(body);
    }

    private static ResponseEntity<Map<String, Object>> notFound() {
        return ResponseEntity.status(404).body(Map.<String, Object>of("error", "unknown_share"));
    }

    private static String str(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    @SuppressWarnings("unchecked")
    private static List<String> toStringList(Object value) {
        if (!(value instanceof List<?> raw)) {
            return List.of();
        }
        List<String> out = new ArrayList<>(raw.size());
        for (Object item : raw) {
            if (item != null) {
                out.add(String.valueOf(item));
            }
        }
        return out;
    }

    private static Instant parseInstant(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(value);
        } catch (Exception e) {
            return null;
        }
    }
}
