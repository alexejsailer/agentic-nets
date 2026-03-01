package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Gateway health check.
 */
@RestController
@RequestMapping("/api/health")
@CrossOrigin(origins = "*")
public class HealthController {

    private final GatewayProperties gatewayProperties;
    private final WebClient webClient;

    public HealthController(GatewayProperties gatewayProperties) {
        this.gatewayProperties = gatewayProperties;
        this.webClient = WebClient.builder()
                .baseUrl(gatewayProperties.getMasterUrl())
                .build();
    }

    @GetMapping
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> health = new LinkedHashMap<>();
        health.put("status", "UP");
        health.put("service", "agentic-net-gateway");
        health.put("timestamp", Instant.now().toString());
        health.put("masterUrl", gatewayProperties.getMasterUrl());
        return ResponseEntity.ok(health);
    }

    @GetMapping("/detailed")
    public Mono<ResponseEntity<Map<String, Object>>> detailedHealth() {
        return webClient.get()
                .uri("/api/health")
                .retrieve()
                .bodyToMono(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(Duration.ofSeconds(5))
                .onErrorResume(error -> Mono.just(Map.of(
                        "status", "DOWN",
                        "error", error.getMessage()
                )))
                .map(masterHealth -> {
                    Map<String, Object> health = new LinkedHashMap<>();
                    health.put("status", "UP");
                    health.put("service", "agentic-net-gateway");
                    health.put("timestamp", Instant.now().toString());
                    health.put("master", masterHealth);
                    return ResponseEntity.ok(health);
                });
    }

    @GetMapping("/ping")
    public ResponseEntity<String> ping() {
        return ResponseEntity.ok("pong");
    }
}
