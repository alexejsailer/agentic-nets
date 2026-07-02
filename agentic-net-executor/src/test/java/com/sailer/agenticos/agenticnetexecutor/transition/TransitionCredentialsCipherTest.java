package com.sailer.agenticos.agenticnetexecutor.transition;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Tests for {@link TransitionCredentialsCipher}: the executor decrypts credential blobs delivered by master
 * using AES-256-CBC with a SHA-256(shared-key) derived key. Guards the round-trip (a blob encrypted with the
 * shared key decrypts back to the original map) and the failure modes that must never silently succeed:
 * wrong key, missing key, and an incomplete blob.
 */
class TransitionCredentialsCipherTest {

    private static final String KEY = "super-secret-shared-key-value";

    private TransitionCredentialsCipher cipherConfiguredWith(String key) {
        MockEnvironment env = new MockEnvironment();
        if (key != null) {
            env.setProperty("agenticos.credentials.key", key);
        }
        return new TransitionCredentialsCipher(env);
    }

    /** Encrypt a payload with the SAME scheme the executor decrypts (AES-256-CBC/PKCS5, SHA-256(key)). */
    private EncryptedCredentials encryptWith(String key, Map<String, Object> payload) throws Exception {
        byte[] keyBytes = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
        byte[] iv = new byte[16];
        new SecureRandom().nextBytes(iv);
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(keyBytes, "AES"), new IvParameterSpec(iv));
        byte[] ct = c.doFinal(new ObjectMapper().writeValueAsBytes(payload));
        return new EncryptedCredentials("AES/CBC/PKCS5Padding",
                Base64.getEncoder().encodeToString(iv),
                Base64.getEncoder().encodeToString(ct),
                "test-key-id");
    }

    private Map<String, Object> secret() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("token", "abc123");
        m.put("username", "svc-account");
        m.put("scope", "readonly");
        return m;
    }

    @Test
    void decryptsBlobEncryptedWithTheSharedKey() throws Exception {
        TransitionCredentialsCipher cipher = cipherConfiguredWith(KEY);
        Map<String, Object> out = cipher.decrypt(encryptWith(KEY, secret()));
        assertEquals("abc123", out.get("token"));
        assertEquals("svc-account", out.get("username"));
        assertEquals("readonly", out.get("scope"));
    }

    @Test
    void wrongKeyCannotDecrypt() throws Exception {
        // blob encrypted with a different key than the cipher is configured with
        EncryptedCredentials blob = encryptWith("a-totally-different-key", secret());
        TransitionCredentialsCipher cipher = cipherConfiguredWith(KEY);
        assertThrows(RuntimeException.class, () -> cipher.decrypt(blob),
                "a blob encrypted under a different key must fail to decrypt, never return garbage");
    }

    @Test
    void missingKeyRefusesToDecrypt() throws Exception {
        EncryptedCredentials blob = encryptWith(KEY, secret());
        TransitionCredentialsCipher noKey = cipherConfiguredWith(null); // AGENTICOS_CREDENTIALS_KEY unset
        assertThrows(IllegalStateException.class, () -> noKey.decrypt(blob),
                "an unconfigured cipher must refuse rather than attempt decryption");
    }

    @Test
    void incompleteBlobIsRejected() {
        TransitionCredentialsCipher cipher = cipherConfiguredWith(KEY);
        EncryptedCredentials incomplete = new EncryptedCredentials("AES/CBC/PKCS5Padding", null, null, "test-key-id");
        assertThrows(IllegalArgumentException.class, () -> cipher.decrypt(incomplete));
    }

    @Test
    void nullBlobIsRejected() {
        TransitionCredentialsCipher cipher = cipherConfiguredWith(KEY);
        assertThrows(NullPointerException.class, () -> cipher.decrypt(null));
    }
}
