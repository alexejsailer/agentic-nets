package com.sailer.agenticos.agenticnetgateway.rest;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Map;

import static org.hamcrest.Matchers.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Integration tests for the /internal/masters/* registration API.
 * Validates the full Spring MVC stack — controller, service, security passthrough.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "gateway.master-url=http://localhost:9999",   // seed master (dummy URL)
        "otel.sdk.disabled=true"
})
class MasterRegistrationControllerTest {

    @Autowired
    private MockMvc mockMvc;

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void register_returnsHeartbeatInterval() throws Exception {
        mockMvc.perform(post("/internal/masters/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "masterId", "test-master-1",
                                "url", "http://master1:8082",
                                "models", List.of("model-a", "model-b")
                        ))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("registered"))
                .andExpect(jsonPath("$.heartbeatIntervalSeconds").isNumber());
    }

    @Test
    void register_missingFields_returnsBadRequest() throws Exception {
        mockMvc.perform(post("/internal/masters/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("masterId", "m1"))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").exists());
    }

    @Test
    void heartbeat_updatesTimestamp() throws Exception {
        // Register first
        mockMvc.perform(post("/internal/masters/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "masterId", "hb-master",
                                "url", "http://master:8082",
                                "models", List.of("*")
                        ))))
                .andExpect(status().isOk());

        // Heartbeat
        mockMvc.perform(post("/internal/masters/heartbeat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("masterId", "hb-master"))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    @Test
    void heartbeat_missingMasterId_returnsBadRequest() throws Exception {
        mockMvc.perform(post("/internal/masters/heartbeat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").exists());
    }

    @Test
    void deregister_removesAndReturnsOk() throws Exception {
        // Register
        mockMvc.perform(post("/internal/masters/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "masterId", "dereg-master",
                                "url", "http://master:8082",
                                "models", List.of("model-x")
                        ))))
                .andExpect(status().isOk());

        // Deregister
        mockMvc.perform(delete("/internal/masters/dereg-master"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("deregistered"));
    }

    @Test
    void listMasters_includesSeedMaster() throws Exception {
        mockMvc.perform(get("/internal/masters"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(greaterThanOrEqualTo(1))))
                .andExpect(jsonPath("$[?(@.masterId == 'seed-master')]").exists());
    }

    @Test
    void listMasters_showsRegisteredMasters() throws Exception {
        // Register a test master
        mockMvc.perform(post("/internal/masters/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "masterId", "list-test-master",
                                "url", "http://master:8082",
                                "models", List.of("model-list")
                        ))))
                .andExpect(status().isOk());

        mockMvc.perform(get("/internal/masters"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.masterId == 'list-test-master')]").exists());
    }

    @Test
    void internalEndpoints_noJwtRequired() throws Exception {
        // /internal/* should be accessible without Authorization header
        mockMvc.perform(get("/internal/masters"))
                .andExpect(status().isOk());
    }
}
