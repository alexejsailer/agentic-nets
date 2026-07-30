package com.sailer.agenticos.agenticnetvault.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailer.agenticos.agenticnetvault.config.VaultProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Self-contained credential backend: AES-256-GCM encrypted files under a local
 * directory, one file per {modelId}/{transitionId}, no external secrets server.
 * The model/transition ids are bound into the ciphertext as AAD, so an envelope
 * copied between transitions fails to decrypt. Fail-closed: an unreadable or
 * undecryptable file throws CredentialStoreException (502) instead of returning
 * null, so a broken store is never mistaken for absent credentials.
 */
@Service
@ConditionalOnProperty(name = "vault.backend", havingValue = "file")
public class FileCredentialStore implements CredentialStore {

    private static final Logger logger = LoggerFactory.getLogger(FileCredentialStore.class);
    private static final Pattern SAFE_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]+$");
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final String ENVELOPE_ALG = "AES-256-GCM";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;
    private static final int KEY_BYTES = 32;
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private final ObjectMapper objectMapper;
    private final Path baseDir;
    private final SecretKey key;
    private final SecureRandom secureRandom = new SecureRandom();

    public FileCredentialStore(VaultProperties properties, ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.baseDir = Path.of(properties.file().path());
        try {
            createPrivateDirectories(baseDir);
            this.key = loadOrCreateKey(Path.of(properties.file().keyFile()));
        } catch (IOException e) {
            throw new CredentialStoreException("Failed to initialize file credential store at " + baseDir, e);
        }
        logger.info("FileCredentialStore initialized — dir={}", baseDir.toAbsolutePath());
    }

    @Override
    public synchronized void write(String modelId, String transitionId, Map<String, Object> credentials) {
        Path file = credentialFile(modelId, transitionId);
        StoredCredentials existing = readIfPresent(file, modelId, transitionId);
        int version = existing == null
            ? 1
            : ((Number) existing.metadata().getOrDefault("version", 0)).intValue() + 1;

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("version", version);
        metadata.put("created_time", Instant.now().toString());

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("data", credentials);
        payload.put("metadata", metadata);

        try {
            byte[] plaintext = objectMapper.writeValueAsBytes(payload);
            byte[] envelope = encrypt(plaintext, aad(modelId, transitionId));
            createPrivateDirectories(file.getParent());
            writeAtomically(file, envelope);
        } catch (IOException e) {
            throw new CredentialStoreException(
                "Failed to write credentials for " + modelId + "/" + transitionId, e);
        }
        logger.info("Stored credentials for {}/{} (version {}, {} keys)",
            modelId, transitionId, version, credentials.size());
    }

    @Override
    public synchronized StoredCredentials read(String modelId, String transitionId) {
        return readIfPresent(credentialFile(modelId, transitionId), modelId, transitionId);
    }

    @Override
    public synchronized void delete(String modelId, String transitionId) {
        Path file = credentialFile(modelId, transitionId);
        try {
            Files.deleteIfExists(file);
        } catch (IOException e) {
            throw new CredentialStoreException(
                "Failed to delete credentials for " + modelId + "/" + transitionId, e);
        }
        logger.info("Deleted credentials for {}/{}", modelId, transitionId);
    }

    @Override
    public boolean isHealthy() {
        return Files.isDirectory(baseDir) && Files.isWritable(baseDir);
    }

    @Override
    public String backendName() {
        return "file";
    }

    private StoredCredentials readIfPresent(Path file, String modelId, String transitionId) {
        if (!Files.exists(file)) {
            return null;
        }
        try {
            byte[] envelope = Files.readAllBytes(file);
            byte[] plaintext = decrypt(envelope, aad(modelId, transitionId));
            Map<String, Object> payload = objectMapper.readValue(plaintext, MAP_TYPE);
            @SuppressWarnings("unchecked")
            Map<String, Object> data = (Map<String, Object>) payload.get("data");
            @SuppressWarnings("unchecked")
            Map<String, Object> metadata = (Map<String, Object>) payload.get("metadata");
            return new StoredCredentials(data, metadata == null ? Map.of() : metadata);
        } catch (IOException e) {
            throw new CredentialStoreException(
                "Failed to read credentials for " + modelId + "/" + transitionId, e);
        }
    }

    private byte[] encrypt(byte[] plaintext, byte[] aad) throws IOException {
        try {
            byte[] iv = new byte[IV_BYTES];
            secureRandom.nextBytes(iv);
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            cipher.updateAAD(aad);
            byte[] ciphertext = cipher.doFinal(plaintext);

            Map<String, Object> envelope = new LinkedHashMap<>();
            envelope.put("v", 1);
            envelope.put("alg", ENVELOPE_ALG);
            envelope.put("iv", Base64.getEncoder().encodeToString(iv));
            envelope.put("ciphertext", Base64.getEncoder().encodeToString(ciphertext));
            return objectMapper.writeValueAsBytes(envelope);
        } catch (GeneralSecurityException e) {
            throw new CredentialStoreException("Encryption failed", e);
        }
    }

    private byte[] decrypt(byte[] envelopeBytes, byte[] aad) throws IOException {
        Map<String, Object> envelope = objectMapper.readValue(envelopeBytes, MAP_TYPE);
        if (!ENVELOPE_ALG.equals(envelope.get("alg"))) {
            throw new CredentialStoreException("Unsupported envelope algorithm: " + envelope.get("alg"));
        }
        try {
            byte[] iv = Base64.getDecoder().decode(String.valueOf(envelope.get("iv")));
            byte[] ciphertext = Base64.getDecoder().decode(String.valueOf(envelope.get("ciphertext")));
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            cipher.updateAAD(aad);
            return cipher.doFinal(ciphertext);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new CredentialStoreException(
                "Decryption failed (wrong key or corrupt credential file)", e);
        }
    }

    private byte[] aad(String modelId, String transitionId) {
        return (modelId + "/" + transitionId).getBytes(StandardCharsets.UTF_8);
    }

    private SecretKey loadOrCreateKey(Path keyFile) throws IOException {
        if (Files.exists(keyFile)) {
            byte[] bytes;
            try {
                bytes = HexFormat.of().parseHex(Files.readString(keyFile).trim());
            } catch (IllegalArgumentException e) {
                throw new CredentialStoreException("Key file " + keyFile + " is not valid hex", e);
            }
            if (bytes.length != KEY_BYTES) {
                throw new CredentialStoreException(
                    "Key file " + keyFile + " must contain " + KEY_BYTES + " bytes (hex-encoded)");
            }
            return new SecretKeySpec(bytes, "AES");
        }
        if (keyFile.getParent() != null) {
            createPrivateDirectories(keyFile.getParent());
        }
        byte[] bytes = new byte[KEY_BYTES];
        secureRandom.nextBytes(bytes);
        Files.writeString(keyFile, HexFormat.of().formatHex(bytes));
        restrictFilePermissions(keyFile);
        logger.info("Generated new credential store key at {}", keyFile.toAbsolutePath());
        return new SecretKeySpec(bytes, "AES");
    }

    private void writeAtomically(Path file, byte[] content) throws IOException {
        Path tmp = Files.createTempFile(file.getParent(), "." + file.getFileName(), ".tmp");
        try {
            restrictFilePermissions(tmp);
            Files.write(tmp, content);
            try {
                Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    private void createPrivateDirectories(Path dir) throws IOException {
        Files.createDirectories(dir);
        try {
            Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException e) {
            // non-POSIX filesystem (Windows) — rely on user-profile ACLs
        }
    }

    private void restrictFilePermissions(Path file) {
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            // non-POSIX filesystem (Windows) — rely on user-profile ACLs
        }
    }

    private Path credentialFile(String modelId, String transitionId) {
        validatePathSegment(modelId, "modelId");
        validatePathSegment(transitionId, "transitionId");
        return baseDir.resolve(modelId).resolve(transitionId + ".cred");
    }

    private void validatePathSegment(String value, String paramName) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(paramName + " must not be empty");
        }
        if (!SAFE_ID_PATTERN.matcher(value).matches()) {
            throw new IllegalArgumentException(
                paramName + " contains invalid characters (allowed: alphanumeric, dash, underscore)");
        }
    }
}
