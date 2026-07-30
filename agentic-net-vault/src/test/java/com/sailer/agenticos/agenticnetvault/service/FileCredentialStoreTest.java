package com.sailer.agenticos.agenticnetvault.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailer.agenticos.agenticnetvault.config.VaultProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;

import static org.assertj.core.api.Assertions.*;

class FileCredentialStoreTest {

    private static final String MODEL_ID = "model-1";
    private static final String TRANSITION_ID = "trans-1";

    @TempDir
    Path tempDir;

    private FileCredentialStore store;

    @BeforeEach
    void setUp() {
        store = newStore();
    }

    private FileCredentialStore newStore() {
        VaultProperties properties = new VaultProperties(
            "file", null, null, null, null, null,
            new VaultProperties.FileStoreProperties(
                tempDir.resolve("credentials").toString(),
                tempDir.resolve("vault.key").toString()));
        return new FileCredentialStore(properties, new ObjectMapper());
    }

    private Path credentialFile(String modelId, String transitionId) {
        return tempDir.resolve("credentials").resolve(modelId).resolve(transitionId + ".cred");
    }

    @Test
    void roundTrip_writeReadDelete() {
        Map<String, Object> credentials = Map.of("apiKey", "sk-secret-123", "authHeader", "Bearer tok");

        store.write(MODEL_ID, TRANSITION_ID, credentials);

        StoredCredentials stored = store.read(MODEL_ID, TRANSITION_ID);
        assertThat(stored).isNotNull();
        assertThat(stored.data()).containsEntry("apiKey", "sk-secret-123");
        assertThat(stored.metadata()).containsEntry("version", 1);
        assertThat(stored.metadata()).containsKey("created_time");

        store.delete(MODEL_ID, TRANSITION_ID);
        assertThat(store.read(MODEL_ID, TRANSITION_ID)).isNull();
    }

    @Test
    void versionIncrementsAcrossWrites() {
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "v1"));
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "v2"));
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "v3"));

        StoredCredentials stored = store.read(MODEL_ID, TRANSITION_ID);
        assertThat(stored.data()).containsEntry("apiKey", "v3");
        assertThat(stored.metadata()).containsEntry("version", 3);
    }

    @Test
    void read_returnsNullWhenAbsent() {
        assertThat(store.read(MODEL_ID, "never-written")).isNull();
    }

    @Test
    void filesAreEncryptedOnDisk() throws Exception {
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "sk-secret-123"));

        byte[] raw = Files.readAllBytes(credentialFile(MODEL_ID, TRANSITION_ID));
        String rawText = new String(raw, StandardCharsets.UTF_8);
        assertThat(rawText).doesNotContain("sk-secret-123");
        assertThat(rawText).doesNotContain("apiKey");
        assertThat(rawText).contains("AES-256-GCM");
    }

    @Test
    void corruptFile_failsClosed() throws Exception {
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "sk-secret-123"));
        Files.write(credentialFile(MODEL_ID, TRANSITION_ID), "not an envelope".getBytes(StandardCharsets.UTF_8));

        assertThatThrownBy(() -> store.read(MODEL_ID, TRANSITION_ID))
            .isInstanceOf(CredentialStoreException.class);
    }

    @Test
    void wrongKey_failsClosed() throws Exception {
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "sk-secret-123"));

        // Replace the key file — a store initialized from it must not decrypt old data
        Files.writeString(tempDir.resolve("vault.key"), "00".repeat(32));
        FileCredentialStore otherKeyStore = newStore();

        assertThatThrownBy(() -> otherKeyStore.read(MODEL_ID, TRANSITION_ID))
            .isInstanceOf(CredentialStoreException.class)
            .hasMessageContaining("Decryption failed");
    }

    @Test
    void aadBindsEnvelopeToItsTransition() throws Exception {
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "sk-secret-123"));

        // Copy the encrypted file to a different transition id — decrypt must fail
        Path target = credentialFile(MODEL_ID, "other-transition");
        Files.createDirectories(target.getParent());
        Files.copy(credentialFile(MODEL_ID, TRANSITION_ID), target);

        assertThatThrownBy(() -> store.read(MODEL_ID, "other-transition"))
            .isInstanceOf(CredentialStoreException.class)
            .hasMessageContaining("Decryption failed");
    }

    @Test
    void restartWithSameKey_readsExistingData() {
        store.write(MODEL_ID, TRANSITION_ID, Map.of("apiKey", "sk-secret-123"));

        FileCredentialStore reloaded = newStore();
        StoredCredentials stored = reloaded.read(MODEL_ID, TRANSITION_ID);

        assertThat(stored).isNotNull();
        assertThat(stored.data()).containsEntry("apiKey", "sk-secret-123");
    }

    @Test
    void keyFileHasRestrictivePermissions() throws Exception {
        Path keyFile = tempDir.resolve("vault.key");
        assertThat(Files.exists(keyFile)).isTrue();
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(keyFile)))
            .isEqualTo("rw-------");
    }

    @Test
    void rejectsPathTraversal() {
        assertThatThrownBy(() -> store.read("../evil", TRANSITION_ID))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("invalid characters");

        assertThatThrownBy(() -> store.write("model/evil", TRANSITION_ID, Map.of("k", "v")))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("invalid characters");

        assertThatThrownBy(() -> store.read("", TRANSITION_ID))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("must not be empty");
    }

    @Test
    void isHealthy_whenDirectoryWritable() {
        assertThat(store.isHealthy()).isTrue();
        assertThat(store.backendName()).isEqualTo("file");
    }
}
