package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;

/**
 * OAuth2 token endpoint — validates client credentials and returns a signed JWT.
 *
 * POST /oauth2/token (application/x-www-form-urlencoded)
 *   grant_type=client_credentials
 *   client_id=agenticos-admin
 *   client_secret=<secret>
 */
@RestController
public class TokenController {

    private static final Logger logger = LoggerFactory.getLogger(TokenController.class);

    private final JwtEncoder jwtEncoder;
    private final GatewayProperties props;

    public TokenController(JwtEncoder jwtEncoder, GatewayProperties props) {
        this.jwtEncoder = jwtEncoder;
        this.props = props;
    }

    @PostMapping(value = "/oauth2/token", consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
    public ResponseEntity<Map<String, Object>> token(
            @RequestParam("grant_type") String grantType,
            @RequestParam("client_id") String clientId,
            @RequestParam("client_secret") String clientSecret,
            @RequestParam(value = "executor_id", required = false) String executorId) {

        if (props.getClientSecret() == null || props.getClientSecret().isBlank()) {
            logger.error("Token endpoint called but gateway client secret is not configured");
            return ResponseEntity.status(503).body(Map.of("error", "server_not_configured"));
        }

        if (!"client_credentials".equals(grantType)) {
            return ResponseEntity.badRequest().body(Map.of("error", "unsupported_grant_type"));
        }

        String scope = resolveScope(clientId, clientSecret, executorId);
        if (scope == null) {
            logger.warn("Invalid client credentials for client_id={}", clientId);
            return ResponseEntity.status(401).body(Map.of("error", "invalid_client"));
        }

        long expiresIn = props.getTokenTtlSeconds();
        Instant now = Instant.now();
        JwtClaimsSet.Builder claimsBuilder = JwtClaimsSet.builder()
                .issuer("agenticos")
                .subject(clientId)
                .issuedAt(now)
                .expiresAt(now.plusSeconds(expiresIn))
                .claim("scope", scope);
        // Executor identity travels IN the token: the scope filter pins poll/discover to it and the
        // proxy hands it to master as X-Agenticos-Executor-Id (clients cannot forge that header).
        if ("agenticos executor".equals(scope) && executorId != null && !executorId.isBlank()) {
            claimsBuilder.claim("executorId", executorId.trim());
        }
        JwtClaimsSet claims = claimsBuilder.build();

        String jwt = jwtEncoder.encode(JwtEncoderParameters.from(claims)).getTokenValue();

        logger.info("JWT issued for client_id={} scope={}", clientId, scope);

        return ResponseEntity.ok(Map.of(
                "access_token", jwt,
                "token_type", "Bearer",
                "expires_in", expiresIn,
                "scope", scope));
    }

    /** Back-compatible entry point (no executor identity) used by existing callers and tests. */
    public ResponseEntity<Map<String, Object>> token(String grantType, String clientId, String clientSecret) {
        return token(grantType, clientId, clientSecret, null);
    }

    /**
     * Match presented credentials against the configured admin, readonly, or executor client pair.
     * Returns the scope claim to issue, or {@code null} if no match.
     */
    private String resolveScope(String clientId, String clientSecret, String executorId) {
        if (secureEquals(props.getClientId(), clientId)
                && secureEquals(props.getClientSecret(), clientSecret)) {
            return "agenticos admin";
        }
        String readonlySecret = props.getReadonlyClientSecret();
        if (readonlySecret != null && !readonlySecret.isBlank()
                && secureEquals(props.getReadonlyClientId(), clientId)
                && secureEquals(readonlySecret, clientSecret)) {
            return "agenticos readonly";
        }
        if (secureEquals(props.getExecutorClientId(), clientId)) {
            // A pinned executor (its own secret via AGENTICOS_EXECUTOR_SECRET_<ID> or the file
            // <jwt-key-dir>/executor-<id>-secret) must present THAT secret: the shared executor
            // secret can then no longer impersonate it. Unpinned executors use the shared secret.
            String pinned = pinnedExecutorSecret(executorId);
            if (pinned != null) {
                return secureEquals(pinned, clientSecret) ? "agenticos executor" : null;
            }
            String executorSecret = props.getExecutorClientSecret();
            if (executorSecret != null && !executorSecret.isBlank() && secureEquals(executorSecret, clientSecret)) {
                return "agenticos executor";
            }
        }
        return null;
    }

    /** Per-executor secret lookup: env AGENTICOS_EXECUTOR_SECRET_&lt;ID&gt; (non-alphanumerics -> '_', upper) or a key-dir file. */
    String pinnedExecutorSecret(String executorId) {
        if (executorId == null || executorId.isBlank()) return null;
        String id = executorId.trim();
        String envKey = "AGENTICOS_EXECUTOR_SECRET_" + id.replaceAll("[^A-Za-z0-9]", "_").toUpperCase(java.util.Locale.ROOT);
        String fromEnv = System.getenv(envKey);
        if (fromEnv != null && !fromEnv.isBlank()) return fromEnv.trim();
        if (!id.matches("[A-Za-z0-9._-]{1,120}")) return null; // never let the id shape a path
        java.nio.file.Path file = java.nio.file.Path.of(props.getJwtKeyDir(), "executor-" + id + "-secret");
        try {
            if (java.nio.file.Files.isRegularFile(file)) {
                String s = java.nio.file.Files.readString(file).trim();
                return s.isEmpty() ? null : s;
            }
        } catch (java.io.IOException ignored) {
            // treat as unpinned
        }
        return null;
    }

    private static boolean secureEquals(String expected, String provided) {
        byte[] left = expected == null ? new byte[0] : expected.getBytes(StandardCharsets.UTF_8);
        byte[] right = provided == null ? new byte[0] : provided.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(left, right);
    }
}
