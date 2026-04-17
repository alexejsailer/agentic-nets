package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class TokenControllerTest {

    private static final String ADMIN_ID = "agenticos-admin";
    private static final String ADMIN_SECRET = "admin-secret-value";
    private static final String READONLY_ID = "agenticos-readonly";
    private static final String READONLY_SECRET = "readonly-secret-value";

    private JwtEncoder jwtEncoder;
    private GatewayProperties props;
    private TokenController controller;
    private Jwt stubJwt;

    @BeforeEach
    void setUp() {
        jwtEncoder = mock(JwtEncoder.class);
        stubJwt = Jwt.withTokenValue("signed.jwt.value")
                .header("alg", "RS256")
                .claims(c -> c.putAll(Map.of("scope", "whatever")))
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .build();
        when(jwtEncoder.encode(any(JwtEncoderParameters.class))).thenReturn(stubJwt);

        props = new GatewayProperties();
        props.setClientId(ADMIN_ID);
        props.setClientSecret(ADMIN_SECRET);
        props.setReadonlyClientId(READONLY_ID);
        props.setReadonlyClientSecret(READONLY_SECRET);
        props.setTokenTtlSeconds(3600);

        controller = new TokenController(jwtEncoder, props);
    }

    @Test
    void adminCredentials_issuesAdminScope() {
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "client_credentials", ADMIN_ID, ADMIN_SECRET);

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        assertThat(resp.getBody()).containsEntry("scope", "agenticos admin");
        assertThat(resp.getBody()).containsEntry("access_token", stubJwt.getTokenValue());
    }

    @Test
    void readonlyCredentials_issuesReadonlyScope() {
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "client_credentials", READONLY_ID, READONLY_SECRET);

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        assertThat(resp.getBody()).containsEntry("scope", "agenticos readonly");
    }

    @Test
    void wrongPassword_returns401() {
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "client_credentials", ADMIN_ID, "wrong");

        assertThat(resp.getStatusCode().value()).isEqualTo(401);
        assertThat(resp.getBody()).containsEntry("error", "invalid_client");
    }

    @Test
    void unknownClientId_returns401() {
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "client_credentials", "agenticos-ghost", "whatever");

        assertThat(resp.getStatusCode().value()).isEqualTo(401);
    }

    @Test
    void readonlyCredentials_whenReadonlySecretBlank_rejects() {
        props.setReadonlyClientSecret("");
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "client_credentials", READONLY_ID, READONLY_SECRET);

        // Blank configured secret disables the readonly path — must not match anything.
        assertThat(resp.getStatusCode().value()).isEqualTo(401);
    }

    @Test
    void adminSecretMustNotMatchReadonlyClientId() {
        // Prevent cross-wired credential confusion: admin-secret + readonly-id must not authenticate.
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "client_credentials", READONLY_ID, ADMIN_SECRET);

        assertThat(resp.getStatusCode().value()).isEqualTo(401);
    }

    @Test
    void unsupportedGrantType_returns400() {
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "password", ADMIN_ID, ADMIN_SECRET);

        assertThat(resp.getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void unconfiguredServer_returns503() {
        props.setClientSecret("");
        ResponseEntity<Map<String, Object>> resp = controller.token(
                "client_credentials", ADMIN_ID, ADMIN_SECRET);

        assertThat(resp.getStatusCode().value()).isEqualTo(503);
    }
}
