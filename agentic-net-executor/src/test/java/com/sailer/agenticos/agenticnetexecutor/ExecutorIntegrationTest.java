package com.sailer.agenticos.agenticnetexecutor;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration test for AgenticNet Executor
 *
 * Tests basic service functionality and API endpoints
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ExecutorIntegrationTest {

    @Autowired
    private TestRestTemplate restTemplate;

    @Test
    void contextLoads() {
        // Verify Spring context loads successfully
    }

    @Test
    void healthEndpointReturnsOk() {
        ResponseEntity<Map> response = restTemplate.getForEntity("/api/health", Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().get("status")).isEqualTo("UP");
        assertThat(response.getBody().get("service")).isEqualTo("agentic-net-executor");
    }

    @Test
    void pingEndpointReturnsPong() {
        ResponseEntity<String> response = restTemplate.getForEntity("/api/health/ping", String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isEqualTo("pong");
    }

    @Test
    void detailedHealthShowsCapabilities() {
        ResponseEntity<Map> response = restTemplate.getForEntity("/api/health/detailed", Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();

        @SuppressWarnings("unchecked")
        Map<String, Object> capabilities = (Map<String, Object>) response.getBody().get("capabilities");

        assertThat(capabilities).isNotNull();
        assertThat(capabilities.get("commandExecution")).isEqualTo(true);
        assertThat(capabilities.get("bashHandler")).isEqualTo(true);
        assertThat(capabilities.get("filesystemHandler")).isEqualTo(true);
        assertThat(capabilities.get("httpHandler")).isEqualTo(true);
    }
}
