package com.sailer.agenticos.agenticnetvault.service;

import com.sailer.agenticos.agenticnetvault.config.VaultProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.vault.core.VaultKeyValueOperations;
import org.springframework.vault.core.VaultKeyValueOperationsSupport;
import org.springframework.vault.core.VaultTemplate;
import org.springframework.vault.support.VaultResponse;

import java.util.Map;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class OpenBaoClientTest {

    @Mock
    private VaultTemplate vaultTemplate;

    @Mock
    private VaultKeyValueOperations kvOps;

    private OpenBaoClient openBaoClient;

    private static final String MODEL_ID = "model-1";
    private static final String TRANSITION_ID = "trans-2";
    private static final String EXPECTED_PATH = "agenticos/credentials/model-1/trans-2";

    @BeforeEach
    void setUp() {
        when(vaultTemplate.opsForKeyValue("secret", VaultKeyValueOperationsSupport.KeyValueBackend.KV_2))
            .thenReturn(kvOps);

        VaultProperties properties = new VaultProperties(
            "http://localhost:8200",
            "test-token",
            "secret",
            "agenticos/credentials",
            null
        );

        openBaoClient = new OpenBaoClient(vaultTemplate, properties);
    }

    @Test
    void write_putsCredentialsAtCorrectPath() {
        Map<String, Object> credentials = Map.of("apiKey", "test-key");

        openBaoClient.write(MODEL_ID, TRANSITION_ID, credentials);

        verify(kvOps).put(EXPECTED_PATH, credentials);
    }

    @Test
    void read_returnsResponseAtCorrectPath() {
        VaultResponse expected = new VaultResponse();
        expected.setData(Map.of("apiKey", "test-key"));
        when(kvOps.get(EXPECTED_PATH)).thenReturn(expected);

        VaultResponse result = openBaoClient.read(MODEL_ID, TRANSITION_ID);

        assertThat(result).isNotNull();
        assertThat(result.getData()).containsEntry("apiKey", "test-key");
    }

    @Test
    void read_returnsNullWhenNotFound() {
        when(kvOps.get(EXPECTED_PATH)).thenReturn(null);

        VaultResponse result = openBaoClient.read(MODEL_ID, TRANSITION_ID);

        assertThat(result).isNull();
    }

    @Test
    void delete_deletesAtCorrectPath() {
        openBaoClient.delete(MODEL_ID, TRANSITION_ID);

        verify(kvOps).delete(EXPECTED_PATH);
    }

    @Test
    void isHealthy_returnsTrueWhenReachable() {
        VaultResponse response = new VaultResponse();
        when(vaultTemplate.read("sys/health")).thenReturn(response);

        assertThat(openBaoClient.isHealthy()).isTrue();
    }

    @Test
    void isHealthy_returnsFalseOnException() {
        when(vaultTemplate.read("sys/health")).thenThrow(new RuntimeException("connection refused"));

        assertThat(openBaoClient.isHealthy()).isFalse();
    }
}
