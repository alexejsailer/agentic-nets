package com.sailer.agenticos.agenticnetvault;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
class OpenBaoIntegrationTest {

    private static final String DEV_ROOT_TOKEN = "test-root-token";

    @Container
    @SuppressWarnings("resource")
    static GenericContainer<?> openbao = new GenericContainer<>("quay.io/openbao/openbao:2.1.0")
        .withExposedPorts(8200)
        .withEnv("BAO_ADDR", "http://0.0.0.0:8200")
        .withCommand("server", "-dev", "-dev-root-token-id=" + DEV_ROOT_TOKEN)
        .waitingFor(Wait.forHttp("/v1/sys/health").forPort(8200).forStatusCode(200));

    @DynamicPropertySource
    static void configureVault(DynamicPropertyRegistry registry) {
        registry.add("vault.openbao-url", () ->
            "http://" + openbao.getHost() + ":" + openbao.getMappedPort(8200));
        registry.add("vault.openbao-token", () -> DEV_ROOT_TOKEN);
        registry.add("vault.kv-mount", () -> "secret");
        registry.add("vault.credentials-path", () -> "agenticos/credentials");
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
            .andExpect(jsonPath("$.metadata.keyNames").isArray());

        // 3. GET — retrieve credentials
        mockMvc.perform(get(baseUrl))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.credentials.apiKey").value("sk-test-123"))
            .andExpect(jsonPath("$.credentials.authHeader").value("Bearer tok"))
            .andExpect(jsonPath("$.metadata.keyNames").isArray())
            .andExpect(jsonPath("$.metadata.version").isNumber());

        // 4. GET metadata — no secret values
        mockMvc.perform(get(baseUrl + "/metadata"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.metadata.keyNames").isArray())
            .andExpect(jsonPath("$.credentials").doesNotExist());

        // 5. PUT — update credentials (version should increment)
        mockMvc.perform(put(baseUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"apiKey\": \"sk-updated-456\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.modelId").value(modelId));

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
    void healthEndpoint_returnsUp() throws Exception {
        mockMvc.perform(get("/api/health"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("UP"))
            .andExpect(jsonPath("$.service").value("agentic-net-vault"));
    }

    @Test
    void detailedHealth_showsBackendReachable() throws Exception {
        mockMvc.perform(get("/api/health/detailed"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capabilities.backendReachable").value(true));
    }

    @Test
    void pingEndpoint_returnsPong() throws Exception {
        mockMvc.perform(get("/api/health/ping"))
            .andExpect(status().isOk())
            .andExpect(content().string("pong"));
    }

    @Test
    void putEmptyCredentials_returnsBadRequest() throws Exception {
        mockMvc.perform(put("/api/vault/m/transitions/t/credentials")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"))
            .andExpect(status().isBadRequest());
    }
}
