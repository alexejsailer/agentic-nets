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
            @RequestParam("client_secret") String clientSecret) {

        if (props.getClientSecret() == null || props.getClientSecret().isBlank()) {
            logger.error("Token endpoint called but gateway client secret is not configured");
            return ResponseEntity.status(503).body(Map.of("error", "server_not_configured"));
        }

        if (!"client_credentials".equals(grantType)) {
            return ResponseEntity.badRequest().body(Map.of("error", "unsupported_grant_type"));
        }

        boolean clientIdOk = secureEquals(props.getClientId(), clientId);
        boolean clientSecretOk = secureEquals(props.getClientSecret(), clientSecret);
        if (!clientIdOk || !clientSecretOk) {
            logger.warn("Invalid client credentials for client_id={}", clientId);
            return ResponseEntity.status(401).body(Map.of("error", "invalid_client"));
        }

        long expiresIn = props.getTokenTtlSeconds();
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer("agenticos")
                .subject(clientId)
                .issuedAt(now)
                .expiresAt(now.plusSeconds(expiresIn))
                .claim("scope", "agenticos admin")
                .build();

        String jwt = jwtEncoder.encode(JwtEncoderParameters.from(claims)).getTokenValue();

        logger.info("JWT issued for client_id={}", clientId);

        return ResponseEntity.ok(Map.of(
                "access_token", jwt,
                "token_type", "Bearer",
                "expires_in", expiresIn));
    }

    private static boolean secureEquals(String expected, String provided) {
        byte[] left = expected == null ? new byte[0] : expected.getBytes(StandardCharsets.UTF_8);
        byte[] right = provided == null ? new byte[0] : provided.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(left, right);
    }
}
