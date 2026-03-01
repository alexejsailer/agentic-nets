package com.sailer.agenticos.agenticnetvault.rest;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import com.sailer.agenticos.agenticnetvault.service.OpenBaoClient;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/health")
@CrossOrigin(origins = "*")
public class HealthController {

    @Value("${spring.application.name:agentic-net-vault}")
    private String applicationName;

    @Value("${info.app.version:0.0.1-SNAPSHOT}")
    private String version;

    @Autowired
    private OpenBaoClient openBaoClient;

    @GetMapping
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> health = new HashMap<>();
        health.put("status", "UP");
        health.put("service", applicationName);
        health.put("version", version);
        health.put("timestamp", Instant.now().toString());

        return ResponseEntity.ok(health);
    }

    @GetMapping("/detailed")
    public ResponseEntity<Map<String, Object>> detailedHealth() {
        Map<String, Object> health = new HashMap<>();
        health.put("status", "UP");
        health.put("service", applicationName);
        health.put("version", version);
        health.put("timestamp", Instant.now().toString());

        Map<String, Object> capabilities = new HashMap<>();
        capabilities.put("secretsManagement", true);
        capabilities.put("kvV2Engine", true);
        capabilities.put("backend", "OpenBao");

        boolean backendReachable;
        try {
            backendReachable = openBaoClient.isHealthy();
        } catch (Exception e) {
            backendReachable = false;
        }
        capabilities.put("backendReachable", backendReachable);
        health.put("capabilities", capabilities);

        return ResponseEntity.ok(health);
    }

    @GetMapping("/ping")
    public ResponseEntity<String> ping() {
        return ResponseEntity.ok("pong");
    }
}
