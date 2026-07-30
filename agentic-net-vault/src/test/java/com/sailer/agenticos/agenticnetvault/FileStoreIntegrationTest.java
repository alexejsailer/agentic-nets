package com.sailer.agenticos.agenticnetvault;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Path;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Same CRUD cycle as OpenBaoIntegrationTest, but against the self-contained
 * file backend — no containers, no external secrets server.
 */
@SpringBootTest
@AutoConfigureMockMvc
class FileStoreIntegrationTest {

    @TempDir
    static Path tempDir;

    @DynamicPropertySource
    static void configureFileBackend(DynamicPropertyRegistry registry) {
        registry.add("vault.backend", () -> "file");
        registry.add("vault.file.path", () -> tempDir.resolve("credentials").toString());
        registry.add("vault.file.key-file", () -> tempDir.resolve("vault.key").toString());
    }

    @Autowired
    private MockMvc mockMvc;

    @Test
    void fullCrudCycle() throws Exception {
        String modelId = "test-model";
        String transitionId = "test-transition";
        String baseUrl = "/api/vault/" + modelId + "/transitions/" + transitionId + "/credentials";

        // 1. GET before store — should be 404
        mockMvc.perform(get(baseUrl))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("Credentials not found"));

        // 2. PUT — store credentials
        mockMvc.perform(put(baseUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"apiKey\": \"sk-test-123\", \"authHeader\": \"Bearer tok\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.modelId").value(modelId))
            .andExpect(jsonPath("$.transitionId").value(transitionId))
            .andExpect(jsonPath("$.metadata.keyNames").isArray())
            .andExpect(jsonPath("$.metadata.version").value(1));

        // 3. GET — retrieve credentials
        mockMvc.perform(get(baseUrl))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.credentials.apiKey").value("sk-test-123"))
            .andExpect(jsonPath("$.credentials.authHeader").value("Bearer tok"))
            .andExpect(jsonPath("$.metadata.keyNames").isArray())
            .andExpect(jsonPath("$.metadata.version").isNumber())
            .andExpect(jsonPath("$.metadata.createdAt").exists());

        // 4. GET metadata — no secret values
        mockMvc.perform(get(baseUrl + "/metadata"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.metadata.keyNames").isArray())
            .andExpect(jsonPath("$.credentials").doesNotExist());

        // 5. PUT — update credentials (version increments)
        mockMvc.perform(put(baseUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"apiKey\": \"sk-updated-456\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.modelId").value(modelId))
            .andExpect(jsonPath("$.metadata.version").value(2));

        // 6. GET — verify update
        mockMvc.perform(get(baseUrl))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.credentials.apiKey").value("sk-updated-456"))
            .andExpect(jsonPath("$.credentials.authHeader").doesNotExist());

        // 7. DELETE — remove credentials
        mockMvc.perform(delete(baseUrl))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.deleted").value(true));

        // 8. GET after delete — should be 404
        mockMvc.perform(get(baseUrl))
            .andExpect(status().isNotFound());
    }

    @Test
    void detailedHealth_reportsFileBackend() throws Exception {
        mockMvc.perform(get("/api/health/detailed"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capabilities.backendReachable").value(true))
            .andExpect(jsonPath("$.capabilities.backend").value("file"))
            .andExpect(jsonPath("$.capabilities.kvV2Engine").value(false));
    }

    @Test
    void pingEndpoint_returnsPong() throws Exception {
        mockMvc.perform(get("/api/health/ping"))
            .andExpect(status().isOk())
            .andExpect(content().string("pong"));
    }
}
