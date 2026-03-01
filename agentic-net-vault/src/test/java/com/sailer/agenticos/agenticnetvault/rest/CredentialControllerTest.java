package com.sailer.agenticos.agenticnetvault.rest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailer.agenticos.agenticnetvault.service.CredentialService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest(CredentialController.class)
class CredentialControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private CredentialService credentialService;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private static final String MODEL_ID = "model-123";
    private static final String TRANSITION_ID = "transition-456";
    private static final String BASE_URL = "/api/vault/{modelId}/transitions/{transitionId}/credentials";

    @Test
    void putCredentials_success() throws Exception {
        Map<String, Object> credentials = Map.of("apiKey", "sk-abc123", "authHeader", "Basic dXNlcjpwYXNz");

        Map<String, Object> serviceResponse = new LinkedHashMap<>();
        serviceResponse.put("modelId", MODEL_ID);
        serviceResponse.put("transitionId", TRANSITION_ID);
        serviceResponse.put("metadata", Map.of(
            "keyNames", List.of("apiKey", "authHeader"),
            "version", 1,
            "updatedAt", "2026-02-22T10:00:00Z"
        ));

        when(credentialService.storeCredentials(eq(MODEL_ID), eq(TRANSITION_ID), anyMap()))
            .thenReturn(serviceResponse);

        mockMvc.perform(put(BASE_URL, MODEL_ID, TRANSITION_ID)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(credentials)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.modelId").value(MODEL_ID))
            .andExpect(jsonPath("$.transitionId").value(TRANSITION_ID))
            .andExpect(jsonPath("$.metadata.keyNames").isArray());
    }

    @Test
    void putCredentials_emptyBody_returnsBadRequest() throws Exception {
        mockMvc.perform(put(BASE_URL, MODEL_ID, TRANSITION_ID)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("Credentials body must not be empty"));
    }

    @Test
    void getCredentials_found() throws Exception {
        Map<String, Object> serviceResponse = new LinkedHashMap<>();
        serviceResponse.put("modelId", MODEL_ID);
        serviceResponse.put("transitionId", TRANSITION_ID);
        serviceResponse.put("credentials", Map.of("apiKey", "sk-abc123"));
        serviceResponse.put("metadata", Map.of("keyNames", List.of("apiKey"), "version", 1));

        when(credentialService.readCredentials(MODEL_ID, TRANSITION_ID))
            .thenReturn(serviceResponse);

        mockMvc.perform(get(BASE_URL, MODEL_ID, TRANSITION_ID))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.modelId").value(MODEL_ID))
            .andExpect(jsonPath("$.credentials.apiKey").value("sk-abc123"));
    }

    @Test
    void getCredentials_notFound() throws Exception {
        when(credentialService.readCredentials(MODEL_ID, TRANSITION_ID))
            .thenReturn(null);

        mockMvc.perform(get(BASE_URL, MODEL_ID, TRANSITION_ID))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("Credentials not found"))
            .andExpect(jsonPath("$.modelId").value(MODEL_ID))
            .andExpect(jsonPath("$.transitionId").value(TRANSITION_ID));
    }

    @Test
    void deleteCredentials_success() throws Exception {
        Map<String, Object> existing = Map.of("modelId", MODEL_ID, "credentials", Map.of("key", "val"));
        when(credentialService.readCredentials(MODEL_ID, TRANSITION_ID))
            .thenReturn(existing);

        mockMvc.perform(delete(BASE_URL, MODEL_ID, TRANSITION_ID))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.deleted").value(true));

        verify(credentialService).deleteCredentials(MODEL_ID, TRANSITION_ID);
    }

    @Test
    void deleteCredentials_notFound() throws Exception {
        when(credentialService.readCredentials(MODEL_ID, TRANSITION_ID))
            .thenReturn(null);

        mockMvc.perform(delete(BASE_URL, MODEL_ID, TRANSITION_ID))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("Credentials not found"));

        verify(credentialService, never()).deleteCredentials(anyString(), anyString());
    }

    @Test
    void getMetadata_found() throws Exception {
        Map<String, Object> serviceResponse = new LinkedHashMap<>();
        serviceResponse.put("modelId", MODEL_ID);
        serviceResponse.put("transitionId", TRANSITION_ID);
        serviceResponse.put("metadata", Map.of("keyNames", List.of("apiKey"), "version", 2));

        when(credentialService.readMetadata(MODEL_ID, TRANSITION_ID))
            .thenReturn(serviceResponse);

        mockMvc.perform(get(BASE_URL + "/metadata", MODEL_ID, TRANSITION_ID))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.metadata.keyNames[0]").value("apiKey"))
            .andExpect(jsonPath("$.credentials").doesNotExist());
    }

    @Test
    void getMetadata_notFound() throws Exception {
        when(credentialService.readMetadata(MODEL_ID, TRANSITION_ID))
            .thenReturn(null);

        mockMvc.perform(get(BASE_URL + "/metadata", MODEL_ID, TRANSITION_ID))
            .andExpect(status().isNotFound());
    }
}
