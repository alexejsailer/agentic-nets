package com.sailer.agenticos.agenticnetgateway.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwsHeader;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Tests for {@link JwtConfig} — the gateway's RSA signing-key lifecycle and the encoder/decoder it exposes.
 * This is a security control: keys must PERSIST across restarts (regenerating them would invalidate every
 * issued access token), be stored owner-only, and the decoder must reject tokens with the wrong issuer. The
 * capstone is a real encode→decode round-trip proving the persisted keypair actually signs and verifies. Driven
 * against a {@code @TempDir} key directory.
 */
class JwtConfigTest {

    @TempDir
    Path keyDir;

    private GatewayProperties props() {
        GatewayProperties p = new GatewayProperties();
        p.setJwtKeyDir(keyDir.toString());
        return p;
    }

    private JwtClaimsSet claims(String issuer) {
        Instant now = Instant.now();
        return JwtClaimsSet.builder()
                .issuer(issuer)
                .subject("test-client")
                .issuedAt(now)
                .expiresAt(now.plusSeconds(300))
                .claim("scope", "admin")
                .build();
    }

    private String sign(JwtConfig config, JwtClaimsSet claims) {
        JwtEncoder encoder = config.jwtEncoder();
        String kid = config.jwkSet().getKeys().get(0).getKeyID();
        JwsHeader header = JwsHeader.with(SignatureAlgorithm.RS256).keyId(kid).build();
        return encoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
    }

    @Test
    void generatesAndPersistsPemKeyPairOnFirstStart() throws Exception {
        new JwtConfig(props());

        Path priv = keyDir.resolve("jwt-private.pem");
        Path pub = keyDir.resolve("jwt-public.pem");
        assertThat(priv).exists();
        assertThat(pub).exists();
        assertThat(Files.readString(priv)).contains("-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----");
        assertThat(Files.readString(pub)).contains("-----BEGIN PUBLIC KEY-----", "-----END PUBLIC KEY-----");
    }

    @Test
    void keyFilesAreOwnerReadWriteOnly() throws Exception {
        new JwtConfig(props());
        Set<PosixFilePermission> perms = Files.getPosixFilePermissions(keyDir.resolve("jwt-private.pem"));
        assertThat(perms).containsExactlyInAnyOrder(
                PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
    }

    @Test
    void exposesExactlyOneRsaKeyAndTheEncoderDecoderBeans() throws Exception {
        JwtConfig config = new JwtConfig(props());
        assertThat(config.jwkSet().getKeys()).hasSize(1);
        assertThat(config.jwkSet().getKeys().get(0).getKeyType().getValue()).isEqualTo("RSA");
        assertThat(config.jwtEncoder()).isNotNull();
        assertThat(config.jwtDecoder()).isNotNull();
    }

    @Test
    void keysAreStableAcrossRestarts() {
        // A second startup over the same directory must LOAD the persisted key, not mint a new one — otherwise
        // every already-issued JWT would fail to verify after a restart.
        String kid1 = new JwtConfig(props()).jwkSet().getKeys().get(0).getKeyID();
        String kid2 = new JwtConfig(props()).jwkSet().getKeys().get(0).getKeyID();
        assertThat(kid2).isEqualTo(kid1);
    }

    @Test
    void aTokenSignedByTheEncoderVerifiesWithTheDecoder() throws Exception {
        JwtConfig config = new JwtConfig(props());
        String token = sign(config, claims("agenticos"));

        Jwt decoded = config.jwtDecoder().decode(token);
        assertThat(decoded.getSubject()).isEqualTo("test-client");
        assertThat(decoded.getClaimAsString("scope")).isEqualTo("admin");
        assertThat(decoded.getClaimAsString("iss")).isEqualTo("agenticos");
    }

    @Test
    void decoderRejectsATokenWithTheWrongIssuer() {
        JwtConfig config = new JwtConfig(props());
        String token = sign(config, claims("impostor"));
        // Signature is valid, but the issuer claim must be "agenticos" — validation must reject it.
        assertThrows(JwtException.class, () -> config.jwtDecoder().decode(token));
    }
}
