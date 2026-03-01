package com.sailer.agenticos.agenticnetvault.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.vault.support.VaultResponse;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class CredentialServiceTest {

    @Mock
    private OpenBaoClient openBaoClient;

    private CredentialService credentialService;

    private static final String MODEL_ID = "model-abc";
    private static final String TRANSITION_ID = "trans-xyz";

    @BeforeEach
    void setUp() {
        credentialService = new CredentialService(openBaoClient);
    }

    @Test
    void storeCredentials_callsClientAndReturnsMetadata() {
        Map<String, Object> credentials = Map.of("apiKey", "sk-123", "secret", "s3cret");

        VaultResponse readBack = new VaultResponse();
        readBack.setData(credentials);
        readBack.setMetadata(Map.of("version", 1));
        when(openBaoClient.read(MODEL_ID, TRANSITION_ID)).thenReturn(readBack);

        Map<String, Object> result = credentialService.storeCredentials(MODEL_ID, TRANSITION_ID, credentials);

        verify(openBaoClient).write(MODEL_ID, TRANSITION_ID, credentials);
        assertThat(result.get("modelId")).isEqualTo(MODEL_ID);
        assertThat(result.get("transitionId")).isEqualTo(TRANSITION_ID);

        @SuppressWarnings("unchecked")
        Map<String, Object> metadata = (Map<String, Object>) result.get("metadata");
        assertThat(metadata.get("keyNames")).isInstanceOf(List.class);
        assertThat(metadata.get("version")).isEqualTo(1);
    }

    @Test
    void readCredentials_returnsDataWhenFound() {
        Map<String, Object> data = new HashMap<>();
        data.put("apiKey", "sk-123");

        VaultResponse response = new VaultResponse();
        response.setData(data);
        response.setMetadata(Map.of("version", 2, "created_time", "2026-01-01T00:00:00Z"));
        when(openBaoClient.read(MODEL_ID, TRANSITION_ID)).thenReturn(response);

        Map<String, Object> result = credentialService.readCredentials(MODEL_ID, TRANSITION_ID);

        assertThat(result).isNotNull();
        assertThat(result.get("modelId")).isEqualTo(MODEL_ID);

        @SuppressWarnings("unchecked")
        Map<String, Object> creds = (Map<String, Object>) result.get("credentials");
        assertThat(creds.get("apiKey")).isEqualTo("sk-123");

        @SuppressWarnings("unchecked")
        Map<String, Object> metadata = (Map<String, Object>) result.get("metadata");
        assertThat(metadata.get("version")).isEqualTo(2);
    }

    @Test
    void readCredentials_returnsNullWhenNotFound() {
        when(openBaoClient.read(MODEL_ID, TRANSITION_ID)).thenReturn(null);

        Map<String, Object> result = credentialService.readCredentials(MODEL_ID, TRANSITION_ID);

        assertThat(result).isNull();
    }

    @Test
    void readMetadata_returnsMetadataOnly() {
        Map<String, Object> data = new HashMap<>();
        data.put("apiKey", "sk-123");
        data.put("secret", "hidden");

        VaultResponse response = new VaultResponse();
        response.setData(data);
        response.setMetadata(Map.of("version", 3));
        when(openBaoClient.read(MODEL_ID, TRANSITION_ID)).thenReturn(response);

        Map<String, Object> result = credentialService.readMetadata(MODEL_ID, TRANSITION_ID);

        assertThat(result).isNotNull();
        assertThat(result).doesNotContainKey("credentials");
        assertThat(result.get("modelId")).isEqualTo(MODEL_ID);

        @SuppressWarnings("unchecked")
        Map<String, Object> metadata = (Map<String, Object>) result.get("metadata");
        @SuppressWarnings("unchecked")
        List<String> keyNames = (List<String>) metadata.get("keyNames");
        assertThat(keyNames).containsExactlyInAnyOrder("apiKey", "secret");
    }

    @Test
    void deleteCredentials_delegatesToClient() {
        credentialService.deleteCredentials(MODEL_ID, TRANSITION_ID);
        verify(openBaoClient).delete(MODEL_ID, TRANSITION_ID);
    }
}
