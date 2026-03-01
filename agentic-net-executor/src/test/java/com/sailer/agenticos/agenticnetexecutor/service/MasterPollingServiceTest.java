package com.sailer.agenticos.agenticnetexecutor.service;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit tests for MasterPollingService
 * Tests service initialization and EmissionTarget record
 */
class MasterPollingServiceTest {

    private static final String MASTER_BASE_URL = "http://localhost:8082";
    private static final String EXECUTOR_ID = "test-executor-1";
    private static final String MODEL_ID = "test-model";

    // Constructor tests removed - MasterPollingService now requires TransitionStore
    // See MasterPollingIntegrationTest for comprehensive integration tests

    @Test
    void testEmissionTarget_RecordCreation() {
        String placeId = "P_test";
        String host = "test-model@localhost:8080";
        List<Map<String, Object>> tokens = List.of(
                Map.of("key1", "value1"),
                Map.of("key2", "value2")
        );

        MasterPollingService.EmissionTarget target = new MasterPollingService.EmissionTarget(
                placeId, host, tokens
        );

        assertThat(target.placeId()).isEqualTo(placeId);
        assertThat(target.host()).isEqualTo(host);
        assertThat(target.tokens()).hasSize(2);
        assertThat(target.tokens().get(0)).containsEntry("key1", "value1");
        assertThat(target.tokens().get(1)).containsEntry("key2", "value2");
    }

    @Test
    void testEmissionTarget_WithComplexTokenData() {
        Map<String, Object> complexToken = Map.of(
                "orderId", "12345",
                "customer", Map.of("name", "John Doe", "email", "john@example.com"),
                "items", List.of(
                        Map.of("sku", "ITEM-001", "quantity", 2),
                        Map.of("sku", "ITEM-002", "quantity", 1)
                ),
                "total", 99.99
        );

        MasterPollingService.EmissionTarget target = new MasterPollingService.EmissionTarget(
                "P_orders",
                "test-model@localhost:8080",
                List.of(complexToken)
        );

        assertThat(target.tokens()).hasSize(1);
        Map<String, Object> token = target.tokens().get(0);
        assertThat(token).containsEntry("orderId", "12345");
        assertThat(token).containsKey("customer");
        assertThat(token).containsKey("items");
    }

    @Test
    void testEmissionTarget_WithEmptyTokens() {
        MasterPollingService.EmissionTarget target = new MasterPollingService.EmissionTarget(
                "P_empty",
                "test-model@localhost:8080",
                List.of()
        );

        assertThat(target.placeId()).isEqualTo("P_empty");
        assertThat(target.tokens()).isEmpty();
    }

    @Test
    void testEmissionTarget_WithMultipleTokens() {
        List<Map<String, Object>> tokens = List.of(
                Map.of("id", "token1", "data", "value1"),
                Map.of("id", "token2", "data", "value2"),
                Map.of("id", "token3", "data", "value3")
        );

        MasterPollingService.EmissionTarget target = new MasterPollingService.EmissionTarget(
                "P_batch",
                "test-model@localhost:8080",
                tokens
        );

        assertThat(target.tokens()).hasSize(3);
        assertThat(target.tokens().get(0)).containsEntry("id", "token1");
        assertThat(target.tokens().get(1)).containsEntry("id", "token2");
        assertThat(target.tokens().get(2)).containsEntry("id", "token3");
    }

    @Test
    void testEmissionTarget_HostFormat_WithModelId() {
        MasterPollingService.EmissionTarget target = new MasterPollingService.EmissionTarget(
                "P_test",
                "other-model@localhost:8080",
                List.of(Map.of("test", "data"))
        );

        // Host format includes modelId
        assertThat(target.host()).isEqualTo("other-model@localhost:8080");
        assertThat(target.host()).contains("@");
    }

    @Test
    void testEmissionTarget_HostFormat_Legacy() {
        MasterPollingService.EmissionTarget target = new MasterPollingService.EmissionTarget(
                "P_test",
                "localhost:8080",
                List.of(Map.of("test", "data"))
        );

        // Legacy host format without modelId
        assertThat(target.host()).isEqualTo("localhost:8080");
        assertThat(target.host()).doesNotContain("@");
    }

    @Test
    void testEmissionTarget_Equality() {
        MasterPollingService.EmissionTarget target1 = new MasterPollingService.EmissionTarget(
                "P_test",
                "test-model@localhost:8080",
                List.of(Map.of("key", "value"))
        );

        MasterPollingService.EmissionTarget target2 = new MasterPollingService.EmissionTarget(
                "P_test",
                "test-model@localhost:8080",
                List.of(Map.of("key", "value"))
        );

        // Records should be equal with same values
        assertThat(target1).isEqualTo(target2);
        assertThat(target1.hashCode()).isEqualTo(target2.hashCode());
    }

    @Test
    void testEmissionTarget_ToString() {
        MasterPollingService.EmissionTarget target = new MasterPollingService.EmissionTarget(
                "P_test",
                "test-model@localhost:8080",
                List.of(Map.of("test", "data"))
        );

        String toString = target.toString();
        assertThat(toString).contains("P_test");
        assertThat(toString).contains("test-model@localhost:8080");
    }
}
