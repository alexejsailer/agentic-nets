package com.sailer.agenticos.agenticnetgateway.config;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

/**
 * JWT configuration — loads a persisted RSA key pair when available,
 * or generates and stores one on first startup.
 */
@Configuration
public class JwtConfig {

    private static final Logger logger = LoggerFactory.getLogger(JwtConfig.class);
    private static final String PRIVATE_KEY_FILE = "jwt-private.pem";
    private static final String PUBLIC_KEY_FILE = "jwt-public.pem";

    private final RSAKey rsaKey;
    private final JWKSet jwkSet;

    public JwtConfig(GatewayProperties properties) {
        try {
            Path keyDir = Path.of(properties.getJwtKeyDir());
            Files.createDirectories(keyDir);
            Path privatePath = keyDir.resolve(PRIVATE_KEY_FILE);
            Path publicPath = keyDir.resolve(PUBLIC_KEY_FILE);

            KeyPair kp = loadOrCreateKeyPair(privatePath, publicPath);
            String keyId = calculateKeyId((RSAPublicKey) kp.getPublic());

            this.rsaKey = new RSAKey.Builder((RSAPublicKey) kp.getPublic())
                    .privateKey((RSAPrivateKey) kp.getPrivate())
                    .keyID(keyId)
                    .build();
            this.jwkSet = new JWKSet(rsaKey);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to initialize JWT keys", e);
        }
    }

    @Bean
    public JwtEncoder jwtEncoder() {
        return new NimbusJwtEncoder(new ImmutableJWKSet<>(jwkSet));
    }

    @Bean
    public JwtDecoder jwtDecoder() throws Exception {
        NimbusJwtDecoder decoder = NimbusJwtDecoder
                .withPublicKey(rsaKey.toRSAPublicKey())
                .signatureAlgorithm(SignatureAlgorithm.RS256)
                .build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                new JwtTimestampValidator(),
                new JwtClaimValidator<String>("iss", "agenticos"::equals)
        ));
        return decoder;
    }

    @Bean
    public JWKSet jwkSet() {
        return jwkSet;
    }

    private KeyPair loadOrCreateKeyPair(Path privatePath, Path publicPath) throws Exception {
        if (Files.exists(privatePath) && Files.exists(publicPath)) {
            try {
                KeyPair loaded = loadKeyPair(privatePath, publicPath);
                logger.info("Loaded persisted gateway JWT keys from {}", privatePath.getParent());
                return loaded;
            } catch (Exception loadError) {
                logger.warn("Failed to load persisted JWT keys, regenerating: {}", loadError.getMessage());
            }
        }

        KeyPair generated = generateRsaKeyPair();
        saveKeyPair(generated, privatePath, publicPath);
        logger.info("Generated new gateway JWT keys at {}", privatePath.getParent());
        return generated;
    }

    private static KeyPair generateRsaKeyPair() throws NoSuchAlgorithmException {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        return gen.generateKeyPair();
    }

    private static KeyPair loadKeyPair(Path privatePath, Path publicPath) throws Exception {
        byte[] privateDer = readPem(privatePath, "PRIVATE KEY");
        byte[] publicDer = readPem(publicPath, "PUBLIC KEY");

        KeyFactory keyFactory = KeyFactory.getInstance("RSA");
        RSAPrivateKey privateKey = (RSAPrivateKey) keyFactory.generatePrivate(new PKCS8EncodedKeySpec(privateDer));
        RSAPublicKey publicKey = (RSAPublicKey) keyFactory.generatePublic(new X509EncodedKeySpec(publicDer));
        return new KeyPair(publicKey, privateKey);
    }

    private static void saveKeyPair(KeyPair keyPair, Path privatePath, Path publicPath) throws IOException {
        writePem(privatePath, "PRIVATE KEY", keyPair.getPrivate().getEncoded());
        writePem(publicPath, "PUBLIC KEY", keyPair.getPublic().getEncoded());
    }

    private static void writePem(Path path, String type, byte[] derBytes) throws IOException {
        String encoded = Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII))
                .encodeToString(derBytes);
        String pem = "-----BEGIN " + type + "-----\n"
                + encoded
                + "\n-----END " + type + "-----\n";

        Files.writeString(path, pem, StandardCharsets.US_ASCII,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        restrictPermissions(path);
    }

    private static void restrictPermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, java.util.Set.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE
            ));
        } catch (UnsupportedOperationException | IOException e) {
            // Non-POSIX filesystem (e.g., Windows) — skip silently
        }
    }

    private static byte[] readPem(Path path, String type) throws IOException {
        String pem = Files.readString(path, StandardCharsets.US_ASCII);
        String begin = "-----BEGIN " + type + "-----";
        String end = "-----END " + type + "-----";
        int start = pem.indexOf(begin);
        int finish = pem.indexOf(end);
        if (start < 0 || finish < 0 || finish <= start) {
            throw new IOException("Invalid PEM format in " + path);
        }

        String base64 = pem.substring(start + begin.length(), finish).replaceAll("\\s+", "");
        return Base64.getDecoder().decode(base64);
    }

    private static String calculateKeyId(RSAPublicKey publicKey) throws NoSuchAlgorithmException {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(publicKey.getEncoded());
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            hex.append(String.format("%02x", digest[i] & 0xff));
        }
        return hex.toString();
    }
}
