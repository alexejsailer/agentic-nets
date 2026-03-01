package com.sailer.agenticos.agenticnetexecutor.transition;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;

/**
 * Decrypts encrypted credentials blobs delivered by agentic-net-master during transition deployment.
 * Uses AES-256-CBC with the shared AGENTICOS_CREDENTIALS_KEY.
 *
 * @deprecated Replaced by agentic-net-vault. Only loaded when agenticos.credentials.key is set
 *             for backward compatibility during migration.
 */
@Deprecated
@Component
@ConditionalOnProperty(name = "agenticos.credentials.key")
public class TransitionCredentialsCipher {

    private static final Logger logger = LoggerFactory.getLogger(TransitionCredentialsCipher.class);
    private static final String CIPHER_ALGO = "AES/CBC/PKCS5Padding";

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final byte[] keyBytes;
    private final String keyId;

    public TransitionCredentialsCipher(Environment environment) {
        String rawKey = environment.getProperty("agenticos.credentials.key");
        if (rawKey == null || rawKey.isBlank()) {
            rawKey = environment.getProperty("AGENTICOS_ENCRYPTION_KEY");
        }

        if (rawKey == null || rawKey.isBlank()) {
            this.keyBytes = null;
            this.keyId = "unset";
            logger.warn("⚠️ Missing AGENTICOS_CREDENTIALS_KEY - encrypted transition credentials cannot be decrypted");
            return;
        }

        this.keyBytes = deriveAesKey(rawKey);
        this.keyId = shortKeyId(rawKey);
        logger.info("🔐 Executor credential decryption ready (keyId={})", keyId);
    }

    public Map<String, Object> decrypt(EncryptedCredentials encrypted) {
        Objects.requireNonNull(encrypted, "encrypted credentials");
        if (!encrypted.isComplete()) {
            throw new IllegalArgumentException("Encrypted credentials blob is incomplete");
        }
        requireKey();

        try {
            Cipher cipher = Cipher.getInstance(CIPHER_ALGO);
            cipher.init(
                    Cipher.DECRYPT_MODE,
                    new SecretKeySpec(keyBytes, "AES"),
                    new IvParameterSpec(Base64.getDecoder().decode(encrypted.iv()))
            );

            byte[] plaintext = cipher.doFinal(Base64.getDecoder().decode(encrypted.ciphertext()));
            @SuppressWarnings("unchecked")
            Map<String, Object> map = objectMapper.readValue(plaintext, Map.class);
            return map;
        } catch (Exception e) {
            logger.error("Failed to decrypt credentials (keyId={}): {}", keyId, e.getMessage());
            throw new RuntimeException("Unable to decrypt transition credentials", e);
        }
    }

    private void requireKey() {
        if (keyBytes == null) {
            throw new IllegalStateException("AGENTICOS_CREDENTIALS_KEY is not configured; cannot decrypt transition credentials");
        }
    }

    private byte[] deriveAesKey(String rawKey) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return digest.digest(rawKey.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("Failed to derive AES key", e);
        }
    }

    private String shortKeyId(String rawKey) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(rawKey.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash).substring(0, 16);
        } catch (Exception e) {
            return "unknown";
        }
    }
}
