package com.sailer.agenticos.agenticnetgateway.rest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.client.WireMock;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.MethodOrderer.OrderAnnotation;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.List;
import java.util.Map;

import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static org.hamcrest.Matchers.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Integration tests for model-based proxy routing.
 * Uses two WireMock servers simulating master-1 (explicit models) and master-2 (wildcard).
 * Validates that the gateway routes requests to the correct master based on modelId.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "gateway.master-url=",         // No seed master — we register our own
        "otel.sdk.disabled=true"
})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(OrderAnnotation.class)
class MasterProxyRoutingTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private MasterRegistryService registryService;

    private final ObjectMapper mapper = new ObjectMapper();

    private WireMockServer master1;
    private WireMockServer master2;

    @BeforeAll
    void startWireMock() {
        master1 = new WireMockServer(0); // random port
        master1.start();

        master2 = new WireMockServer(0);
        master2.start();

        // Register master-1 for model-a, model-b
        registryService.register("master-1",
                "http://localhost:" + master1.port(),
                List.of("model-a", "model-b"));

        // Register master-2 as wildcard
        registryService.register("master-2",
                "http://localhost:" + master2.port(),
                List.of("*"));
    }

    @AfterAll
    void stopWireMock() {
        if (master1 != null) master1.stop();
        if (master2 != null) master2.stop();
    }

    @BeforeEach
    void resetWireMock() {
        master1.resetAll();
        master2.resetAll();
    }

    /**
     * Helper: performs the request, handles async dispatch (Mono), returns final result.
     */
    private MvcResult performAsync(org.springframework.test.web.servlet.RequestBuilder requestBuilder) throws Exception {
        MvcResult asyncResult = mockMvc.perform(requestBuilder)
                .andExpect(request().asyncStarted())
                .andReturn();
        return mockMvc.perform(asyncDispatch(asyncResult)).andReturn();
    }

    // ── Model-based routing via query param ─────────────────────────────────

    @Test
    @WithMockUser
    void routeByQueryParam_modelA_goesToMaster1() throws Exception {
        master1.stubFor(WireMock.get(urlPathEqualTo("/api/transitions/poll"))
                .willReturn(okJson("{\"transitions\":[], \"source\":\"master-1\"}")));

        MvcResult asyncResult = mockMvc.perform(get("/api/transitions/poll")
                        .param("modelId", "model-a")
                        .param("executorId", "test-executor"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.source").value("master-1"));

        master1.verify(getRequestedFor(urlPathEqualTo("/api/transitions/poll")));
        master2.verify(0, getRequestedFor(urlPathEqualTo("/api/transitions/poll")));
    }

    @Test
    @WithMockUser
    void routeByQueryParam_modelB_goesToMaster1() throws Exception {
        master1.stubFor(WireMock.get(urlPathEqualTo("/api/transitions/poll"))
                .willReturn(okJson("{\"transitions\":[], \"source\":\"master-1\"}")));

        MvcResult asyncResult = mockMvc.perform(get("/api/transitions/poll")
                        .param("modelId", "model-b")
                        .param("executorId", "test-executor"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.source").value("master-1"));
    }

    @Test
    @WithMockUser
    void routeByQueryParam_unknownModel_goesToWildcardMaster2() throws Exception {
        master2.stubFor(WireMock.get(urlPathEqualTo("/api/transitions/poll"))
                .willReturn(okJson("{\"transitions\":[], \"source\":\"master-2\"}")));

        MvcResult asyncResult = mockMvc.perform(get("/api/transitions/poll")
                        .param("modelId", "model-unknown")
                        .param("executorId", "test-executor"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.source").value("master-2"));

        master2.verify(getRequestedFor(urlPathEqualTo("/api/transitions/poll")));
    }

    // ── Model-based routing via request body ────────────────────────────────

    @Test
    @WithMockUser
    void routeByBody_modelA_goesToMaster1() throws Exception {
        master1.stubFor(WireMock.post(urlPathEqualTo("/api/transitions/assign"))
                .willReturn(okJson("{\"success\":true, \"source\":\"master-1\"}")));

        MvcResult asyncResult = mockMvc.perform(post("/api/transitions/assign")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "modelId", "model-a",
                                "transitionId", "t1",
                                "agentId", "executor-1"
                        ))))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.source").value("master-1"));

        master1.verify(postRequestedFor(urlPathEqualTo("/api/transitions/assign")));
        master2.verify(0, postRequestedFor(urlPathEqualTo("/api/transitions/assign")));
    }

    // ── Discover fan-out ────────────────────────────────────────────────────

    @Test
    @WithMockUser
    void discoverFanOut_aggregatesFromBothMasters() throws Exception {
        master1.stubFor(WireMock.get(urlPathEqualTo("/api/transitions/discover"))
                .willReturn(okJson(mapper.writeValueAsString(Map.of(
                        "executorId", "exec-1",
                        "assignments", List.of(
                                Map.of("modelId", "model-a", "transitionId", "t1")
                        )
                )))));

        master2.stubFor(WireMock.get(urlPathEqualTo("/api/transitions/discover"))
                .willReturn(okJson(mapper.writeValueAsString(Map.of(
                        "executorId", "exec-1",
                        "assignments", List.of(
                                Map.of("modelId", "model-c", "transitionId", "t2")
                        )
                )))));

        MvcResult asyncResult = mockMvc.perform(get("/api/transitions/discover")
                        .param("executorId", "exec-1"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.assignments", hasSize(2)))
                .andExpect(jsonPath("$.assignments[?(@.transitionId == 't1')]").exists())
                .andExpect(jsonPath("$.assignments[?(@.transitionId == 't2')]").exists());

        // Both masters should have been called
        master1.verify(getRequestedFor(urlPathEqualTo("/api/transitions/discover")));
        master2.verify(getRequestedFor(urlPathEqualTo("/api/transitions/discover")));
    }

    @Test
    @WithMockUser
    void discoverFanOut_withAllowedModels_routesCorrectly() throws Exception {
        master1.stubFor(WireMock.get(urlPathEqualTo("/api/transitions/discover"))
                .willReturn(okJson(mapper.writeValueAsString(Map.of(
                        "executorId", "exec-1",
                        "assignments", List.of(
                                Map.of("modelId", "model-a", "transitionId", "t1")
                        )
                )))));

        master2.stubFor(WireMock.get(urlPathEqualTo("/api/transitions/discover"))
                .willReturn(okJson(mapper.writeValueAsString(Map.of(
                        "executorId", "exec-1",
                        "assignments", List.of()
                )))));

        // allowedModels=model-a should hit master-1 (explicit) and master-2 (wildcard)
        MvcResult asyncResult = mockMvc.perform(get("/api/transitions/discover")
                        .param("executorId", "exec-1")
                        .param("allowedModels", "model-a"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.assignments", hasSize(1)))
                .andExpect(jsonPath("$.assignments[0].transitionId").value("t1"));
    }

    // ── Executor list fan-out ───────────────────────────────────────────────

    @Test
    @WithMockUser
    void executorListFanOut_aggregatesAndDeduplicates() throws Exception {
        master1.stubFor(WireMock.get(urlPathEqualTo("/api/executors"))
                .willReturn(okJson(mapper.writeValueAsString(List.of(
                        Map.of("executorId", "exec-1", "status", "ONLINE"),
                        Map.of("executorId", "exec-2", "status", "ONLINE")
                )))));

        master2.stubFor(WireMock.get(urlPathEqualTo("/api/executors"))
                .willReturn(okJson(mapper.writeValueAsString(List.of(
                        Map.of("executorId", "exec-1", "status", "ONLINE"),   // duplicate
                        Map.of("executorId", "exec-3", "status", "ONLINE")
                )))));

        MvcResult asyncResult = mockMvc.perform(get("/api/executors")
                        .param("activeOnly", "true"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                // exec-1 appears in both, but should be deduplicated
                .andExpect(jsonPath("$", hasSize(3)))
                .andExpect(jsonPath("$[?(@.executorId == 'exec-1')]").exists())
                .andExpect(jsonPath("$[?(@.executorId == 'exec-2')]").exists())
                .andExpect(jsonPath("$[?(@.executorId == 'exec-3')]").exists());
    }

    @Test
    @WithMockUser
    void executorList_withModelId_routesToSingleMaster() throws Exception {
        // When modelId is provided, it should route to the specific master, not fan out
        master1.stubFor(WireMock.get(urlPathEqualTo("/api/executors"))
                .willReturn(okJson(mapper.writeValueAsString(List.of(
                        Map.of("executorId", "exec-1", "status", "ONLINE")
                )))));

        MvcResult asyncResult = mockMvc.perform(get("/api/executors")
                        .param("activeOnly", "true")
                        .param("modelId", "model-a"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].executorId").value("exec-1"));

        master1.verify(getRequestedFor(urlPathEqualTo("/api/executors")));
        // master2 should NOT be called since modelId routes to master-1
        master2.verify(0, getRequestedFor(urlPathEqualTo("/api/executors")));
    }

    // ── Fallback behavior ───────────────────────────────────────────────────

    @Test
    @WithMockUser
    void noModelId_noBody_fallsBackToAnyMaster() throws Exception {
        // Use a non-health path so it doesn't hit actuator
        master1.stubFor(WireMock.get(urlPathEqualTo("/api/some-endpoint"))
                .willReturn(okJson("{\"status\":\"ok\", \"source\":\"master-1\"}")));
        master2.stubFor(WireMock.get(urlPathEqualTo("/api/some-endpoint"))
                .willReturn(okJson("{\"status\":\"ok\", \"source\":\"master-2\"}")));

        MvcResult asyncResult = mockMvc.perform(get("/api/some-endpoint"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(asyncResult))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    // ── Master down scenario ────────────────────────────────────────────────

    @Test
    @WithMockUser
    @Order(Integer.MAX_VALUE)
    void masterDown_returns502() throws Exception {
        // Stop master-1 to simulate it being down
        master1.stop();
        try {
            MvcResult asyncResult = mockMvc.perform(get("/api/transitions/poll")
                            .param("modelId", "model-a")
                            .param("executorId", "test-executor"))
                    .andExpect(request().asyncStarted())
                    .andReturn();

            mockMvc.perform(asyncDispatch(asyncResult))
                    .andExpect(status().is(502))
                    .andExpect(jsonPath("$.error").exists());
        } finally {
            // Restart for other tests
            master1.start();
        }
    }
}
