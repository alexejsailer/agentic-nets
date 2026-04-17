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
import java.nio.file.attribute.PosixFilePermission;
import java.security.SecureRandom;
import java.util.Set;

/**
 * Auto-generates and persists the OAuth2 admin and readonly secrets when none are configured.
 * Follows the same file-persistence pattern as {@link JwtConfig} (RSA key pair).
 *
 * <p>Resolution order (per secret):
 * <ol>
 *   <li>If the corresponding env/property is set, use it (and persist to file)</li>
 *   <li>Else if the secret file exists, load from file</li>
 *   <li>Else generate a 64-char hex secret, save to file</li>
 * </ol>
 *
 * <p>Clients retrieve the secrets via:
 * {@code docker exec agenticos-gateway cat /app/data/jwt/admin-secret}
 * {@code docker exec agenticos-gateway cat /app/data/jwt/readonly-secret}
 */
@Configuration
public class AdminSecretInitializer {

    private static final Logger logger = LoggerFactory.getLogger(AdminSecretInitializer.class);
    private static final String ADMIN_SECRET_FILE = "admin-secret";
    private static final String READONLY_SECRET_FILE = "readonly-secret";
    private static final int SECRET_BYTES = 32; // 32 bytes = 64 hex chars

    private final GatewayProperties properties;

    public AdminSecretInitializer(GatewayProperties properties) {
        this.properties = properties;
    }

    @PostConstruct
    public void initSecrets() throws IOException {
        Path keyDir = Path.of(properties.getJwtKeyDir());
        Files.createDirectories(keyDir);

        initSecret(
                "Admin",
                keyDir.resolve(ADMIN_SECRET_FILE),
                properties.getClientSecret(),
                properties::setClientSecret);

        initSecret(
                "Readonly",
                keyDir.resolve(READONLY_SECRET_FILE),
                properties.getReadonlyClientSecret(),
                properties::setReadonlyClientSecret);
    }

    private void initSecret(String label, Path secretPath, String configured,
                            java.util.function.Consumer<String> sink) throws IOException {
        if (configured != null && !configured.isBlank()) {
            Files.writeString(secretPath, configured, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            restrictPermissions(secretPath);
            logger.info("{} secret persisted to {}", label, secretPath);
            return;
        }

        if (Files.exists(secretPath)) {
            String secret = Files.readString(secretPath, StandardCharsets.UTF_8).strip();
            if (!secret.isBlank()) {
                sink.accept(secret);
                logger.info("{} secret loaded from {}", label, secretPath);
                return;
            }
        }

        String secret = generateHexSecret();
        Files.writeString(secretPath, secret, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        restrictPermissions(secretPath);
        sink.accept(secret);
        logger.info("{} secret generated and saved to {}", label, secretPath);
    }

    private static void restrictPermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, Set.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE
            ));
        } catch (UnsupportedOperationException e) {
            logger.debug("Cannot set POSIX permissions on {} (non-POSIX filesystem)", path);
        } catch (IOException e) {
            logger.warn("Failed to restrict file permissions on {}: {}", path, e.getMessage());
        }
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
