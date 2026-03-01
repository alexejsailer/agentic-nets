package com.sailer.agenticos.agenticnetexecutor.rest;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * Health check controller for AgenticNet Executor service
 *
 * Provides basic health status, system information, and executor capabilities
 */
@RestController
@RequestMapping("/api/health")
@CrossOrigin(origins = "*")
public class HealthController {

    @Value("${spring.application.name:agentic-net-executor}")
    private String applicationName;

    @Value("${info.app.version:0.0.1-SNAPSHOT}")
    private String version;

    @Value("${executor.max-execution-time-ms:600000}")
    private long maxExecutionTimeMs;

    /**
     * Basic health check endpoint
     *
     * @return Health status with timestamp
     */
    @GetMapping
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> health = new HashMap<>();
        health.put("status", "UP");
        health.put("service", applicationName);
        health.put("version", version);
        health.put("timestamp", Instant.now().toString());

        return ResponseEntity.ok(health);
    }

    /**
     * Detailed health check with capabilities
     *
     * @return Detailed health information including executor capabilities
     */
    @GetMapping("/detailed")
    public ResponseEntity<Map<String, Object>> detailedHealth() {
        Map<String, Object> health = new HashMap<>();
        health.put("status", "UP");
        health.put("service", applicationName);
        health.put("version", version);
        health.put("timestamp", Instant.now().toString());

        // Executor capabilities (command-only, egress-only)
        Map<String, Object> capabilities = new HashMap<>();
        capabilities.put("commandExecution", true);
        capabilities.put("bashHandler", true);
        capabilities.put("filesystemHandler", true);
        capabilities.put("httpHandler", true);
        health.put("capabilities", capabilities);

        // Executor configuration
        Map<String, Object> config = new HashMap<>();
        config.put("maxExecutionTimeMs", maxExecutionTimeMs);
        health.put("configuration", config);

        return ResponseEntity.ok(health);
    }

    /**
     * Simple ping endpoint
     *
     * @return Pong response
     */
    @GetMapping("/ping")
    public ResponseEntity<String> ping() {
        return ResponseEntity.ok("pong");
    }
}
