package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.SecureRandom;

/**
 * Auto-generates and persists the OAuth2 admin secret when none is configured.
 * Follows the same file-persistence pattern as {@link JwtConfig} (RSA key pair).
 *
 * <p>Resolution order:
 * <ol>
 *   <li>If {@code gateway.client-secret} is set via env/properties, use it (and persist to file)</li>
 *   <li>Else if {@code {jwtKeyDir}/admin-secret} file exists, load from file</li>
 *   <li>Else generate a 64-char hex secret, save to file</li>
 * </ol>
 *
 * <p>Clients retrieve the secret via:
 * {@code docker exec agenticos-gateway cat /app/data/jwt/admin-secret}
 */
@Configuration
public class AdminSecretInitializer {

    private static final Logger logger = LoggerFactory.getLogger(AdminSecretInitializer.class);
    private static final String SECRET_FILE = "admin-secret";
    private static final int SECRET_BYTES = 32; // 32 bytes = 64 hex chars

    private final GatewayProperties properties;

    public AdminSecretInitializer(GatewayProperties properties) {
        this.properties = properties;
    }

    @PostConstruct
    public void initAdminSecret() throws IOException {
        Path keyDir = Path.of(properties.getJwtKeyDir());
        Files.createDirectories(keyDir);
        Path secretPath = keyDir.resolve(SECRET_FILE);

        String configured = properties.getClientSecret();

        if (configured != null && !configured.isBlank()) {
            // Secret provided via env var — persist to file for container sharing
            Files.writeString(secretPath, configured, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            logger.info("Admin secret persisted to {}", secretPath);
            return;
        }

        if (Files.exists(secretPath)) {
            // Load previously generated secret from file
            String secret = Files.readString(secretPath, StandardCharsets.UTF_8).strip();
            if (!secret.isBlank()) {
                properties.setClientSecret(secret);
                logger.info("Admin secret loaded from {}", secretPath);
                return;
            }
        }

        // Generate new secret
        String secret = generateHexSecret();
        Files.writeString(secretPath, secret, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        properties.setClientSecret(secret);
        logger.info("Admin secret generated and saved to {}", secretPath);
    }

    private static String generateHexSecret() {
        byte[] bytes = new byte[SECRET_BYTES];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder(SECRET_BYTES * 2);
        for (byte b : bytes) {
            hex.append(String.format("%02x", b & 0xff));
        }
        return hex.toString();
    }
}
