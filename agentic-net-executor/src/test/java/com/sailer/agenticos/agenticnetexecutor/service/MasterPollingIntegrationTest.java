package com.sailer.agenticos.agenticnetexecutor.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStatus;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStore;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static java.util.concurrent.TimeUnit.SECONDS;

/**
 * Integration test for MasterPollingService validating complete deployment agentic.
 * Tests the full lifecycle: polling → DEPLOY command → processing → registration
 */
@SpringBootTest
class MasterPollingIntegrationTest {

    private static final String TEST_MODEL = "test-model";

    @Autowired
    private TransitionStore transitionStore;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private com.sailer.agenticos.agenticnetexecutor.transition.runtime.TransitionOrchestrator orchestrator;

    private MockWebServer mockMaster;
    private MasterPollingService pollingService;

    @BeforeEach
    void setUp() throws Exception {
        mockMaster = new MockWebServer();
        mockMaster.start();

        String masterBaseUrl = mockMaster.url("/").toString().replaceAll("/$", "");

        pollingService = new MasterPollingService(
                masterBaseUrl,
                "test-executor-1",
                "",   // no client-id (direct mode)
                "",   // no client-secret
                transitionStore,
                orchestrator
        );

        // Seed discovered models so pollForWork() has models to poll
        pollingService.discoveredModelIds.add(TEST_MODEL);

        // Clear any existing transitions
        transitionStore.list().forEach(def ->
            transitionStore.remove(def.modelId(), def.transitionId())
        );
    }

    @AfterEach
    void tearDown() throws Exception {
        if (mockMaster != null) {
            mockMaster.shutdown();
        }
    }

    @Test
    void testDeployTransition_CompleteFlow() throws Exception {
        String transitionId = "transition_test_001";
        Map<String, Object> inscription = createSampleInscription(transitionId);

        Map<String, Object> pollResponse = Map.of(
                "executorId", "test-executor-1",
                "modelId", TEST_MODEL,
                "polledAt", Instant.now().toString(),
                "transitionCount", 1,
                "transitions", List.of(createTransitionData(transitionId, "DEPLOY", inscription))
        );

        mockMaster.enqueue(new MockResponse()
                .setResponseCode(200)
                .setHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .setBody(objectMapper.writeValueAsString(pollResponse)));

        mockMaster.enqueue(new MockResponse()
                .setResponseCode(200)
                .setHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .setBody("{}"));

        pollingService.pollForWork();

        await().atMost(5, SECONDS).untilAsserted(() -> {
            TransitionDefinition registered = transitionStore.get(TEST_MODEL, transitionId).orElse(null);
            assertThat(registered).isNotNull();
            assertThat(registered.transitionId()).isEqualTo(transitionId);
            assertThat(registered.modelId()).isEqualTo(TEST_MODEL);
            assertThat(registered.status()).isEqualTo(TransitionStatus.REGISTERED);

            TransitionInscription parsedInscription = registered.inscription();
            assertThat(parsedInscription).isNotNull();
            assertThat(parsedInscription.id()).isEqualTo(transitionId);
            assertThat(parsedInscription.presets()).hasSize(1);
            assertThat(parsedInscription.postsets()).hasSize(1);
            assertThat(parsedInscription.action().type()).isEqualTo("command");
        });

        assertThat(mockMaster.getRequestCount()).isEqualTo(2); // poll + deployment status
    }

    @Test
    void testMultipleTransitions_BatchDeployment() throws Exception {
        String transitionId1 = "transition_batch_001";
        String transitionId2 = "transition_batch_002";

        Map<String, Object> pollResponse = Map.of(
                "executorId", "test-executor-1",
                "modelId", TEST_MODEL,
                "polledAt", Instant.now().toString(),
                "transitionCount", 2,
                "transitions", List.of(
                        createTransitionData(transitionId1, "DEPLOY", createSampleInscription(transitionId1)),
                        createTransitionData(transitionId2, "DEPLOY", createSampleInscription(transitionId2))
                )
        );

        mockMaster.enqueue(new MockResponse()
                .setResponseCode(200)
                .setHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .setBody(objectMapper.writeValueAsString(pollResponse)));

        mockMaster.enqueue(new MockResponse().setResponseCode(200).setBody("{}"));
        mockMaster.enqueue(new MockResponse().setResponseCode(200).setBody("{}"));

        pollingService.pollForWork();

        await().atMost(5, SECONDS).untilAsserted(() -> {
            assertThat(transitionStore.get(TEST_MODEL, transitionId1)).isPresent();
            assertThat(transitionStore.get(TEST_MODEL, transitionId2)).isPresent();
        });

        TransitionDefinition def1 = transitionStore.get(TEST_MODEL, transitionId1).get();
        TransitionDefinition def2 = transitionStore.get(TEST_MODEL, transitionId2).get();

        assertThat(def1.transitionId()).isEqualTo(transitionId1);
        assertThat(def1.status()).isEqualTo(TransitionStatus.REGISTERED);
        assertThat(def2.transitionId()).isEqualTo(transitionId2);
        assertThat(def2.status()).isEqualTo(TransitionStatus.REGISTERED);

        assertThat(mockMaster.getRequestCount()).isEqualTo(3); // 1 poll + 2 deployment status
    }

    @Test
    void testStartCommand_UpdatesStatus() throws Exception {
        String transitionId = "transition_start_test";
        TransitionDefinition definition = TransitionDefinition.builder()
                .modelId(TEST_MODEL)
                .transitionId(transitionId)
                .inscription(createSampleInscriptionObject(transitionId))
                .status(TransitionStatus.REGISTERED)
                .build();
        transitionStore.register(definition);

        Map<String, Object> pollResponse = Map.of(
                "executorId", "test-executor-1",
                "modelId", TEST_MODEL,
                "polledAt", Instant.now().toString(),
                "transitionCount", 1,
                "transitions", List.of(
                        createTransitionData(transitionId, "START", createSampleInscription(transitionId))
                )
        );

        mockMaster.enqueue(new MockResponse()
                .setResponseCode(200)
                .setHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .setBody(objectMapper.writeValueAsString(pollResponse)));

        mockMaster.enqueue(new MockResponse().setResponseCode(200).setBody("{}"));

        pollingService.pollForWork();

        await().atMost(5, SECONDS).untilAsserted(() -> {
            TransitionDefinition updated = transitionStore.get(TEST_MODEL, transitionId).orElse(null);
            assertThat(updated).isNotNull();
            assertThat(updated.status()).isEqualTo(TransitionStatus.RUNNING);
        });
    }

    @Test
    void testDeleteCommand_RemovesTransition() throws Exception {
        String transitionId = "transition_delete_test";
        TransitionDefinition definition = TransitionDefinition.builder()
                .modelId(TEST_MODEL)
                .transitionId(transitionId)
                .inscription(createSampleInscriptionObject(transitionId))
                .status(TransitionStatus.REGISTERED)
                .build();
        transitionStore.register(definition);

        Map<String, Object> pollResponse = Map.of(
                "executorId", "test-executor-1",
                "modelId", TEST_MODEL,
                "polledAt", Instant.now().toString(),
                "transitionCount", 1,
                "transitions", List.of(
                        createTransitionData(transitionId, "DELETE", createSampleInscription(transitionId))
                )
        );

        mockMaster.enqueue(new MockResponse()
                .setResponseCode(200)
                .setHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .setBody(objectMapper.writeValueAsString(pollResponse)));

        mockMaster.enqueue(new MockResponse().setResponseCode(200).setBody("{}"));

        pollingService.pollForWork();

        await().atMost(5, SECONDS).untilAsserted(() -> {
            assertThat(transitionStore.get(TEST_MODEL, transitionId)).isEmpty();
        });
    }

    @Test
    void testMasterUnavailable_GracefulDegradation() throws Exception {
        mockMaster.enqueue(new MockResponse().setResponseCode(503));

        pollingService.pollForWork();

        await().during(2, SECONDS).untilAsserted(() -> {
            assertThat(transitionStore.list()).isEmpty();
        });

        assertThat(mockMaster.getRequestCount()).isEqualTo(1);
    }

    // Helper methods

    private Map<String, Object> createTransitionData(String transitionId, String command, Map<String, Object> inscription) {
        Map<String, Object> data = new java.util.HashMap<>();
        data.put("transitionId", transitionId);
        data.put("assignedAgent", "test-executor-1");
        data.put("status", "pending");
        data.put("command", command);
        data.put("inscription", inscription);
        data.put("deployedAt", Instant.now().toString());
        data.put("error", null);
        data.put("metrics", Map.of());
        return data;
    }

    private Map<String, Object> createSampleInscription(String transitionId) {
        return Map.of(
                "id", transitionId,
                "presets", Map.of(
                        "input", Map.of(
                            "placeId", "P_input",
                            "host", "test-model@localhost:8080",
                            "arcql", "FROM $ LIMIT 1",
                            "take", "FIRST",
                            "consume", true
                        )
                ),
                "postsets", Map.of(
                        "output", Map.of(
                            "placeId", "P_output",
                            "host", "test-model@localhost:8080"
                        )
                ),
                "action", Map.of(
                        "type", "command",
                        "inputPlace", "input"
                ),
                "emit", List.of(
                        Map.of(
                                "to", "output",
                                "from", "@input",
                                "when", "success"
                        )
                ),
                "mode", "SINGLE"
        );
    }

    private TransitionInscription createSampleInscriptionObject(String transitionId) {
        Map<String, Object> inscriptionMap = createSampleInscription(transitionId);
        return objectMapper.convertValue(inscriptionMap, TransitionInscription.class);
    }
}
