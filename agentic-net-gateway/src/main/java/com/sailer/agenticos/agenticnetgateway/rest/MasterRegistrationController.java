package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService.MasterNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * Internal API for master node registration. Masters register themselves on startup,
 * send periodic heartbeats, and deregister on shutdown.
 *
 * <p>These endpoints are not behind JWT auth — they fall through to
 * {@code .anyRequest().permitAll()} in SecurityConfig since they don't match {@code /api/**}.</p>
 */
@RestController
@RequestMapping("/internal/masters")
public class MasterRegistrationController {

    private static final Logger logger = LoggerFactory.getLogger(MasterRegistrationController.class);

    private final MasterRegistryService registryService;
    private final GatewayProperties props;

    public MasterRegistrationController(MasterRegistryService registryService, GatewayProperties props) {
        this.registryService = registryService;
        this.props = props;
    }

    @PostMapping("/register")
    public ResponseEntity<Map<String, Object>> register(@RequestBody Map<String, Object> body) {
        String masterId = (String) body.get("masterId");
        String url = (String) body.get("url");
        @SuppressWarnings("unchecked")
        List<String> models = (List<String>) body.get("models");

        if (masterId == null || url == null || models == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "masterId, url, and models are required"));
        }

        registryService.register(masterId, url, models);
        return ResponseEntity.ok(Map.of(
                "status", "registered",
                "heartbeatIntervalSeconds", props.getMasterHeartbeatTtlSeconds() / 4
        ));
    }

    @PostMapping("/heartbeat")
    public ResponseEntity<Map<String, String>> heartbeat(@RequestBody Map<String, String> body) {
        String masterId = body.get("masterId");
        if (masterId == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "masterId is required"));
        }
        registryService.heartbeat(masterId);
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    @DeleteMapping("/{masterId}")
    public ResponseEntity<Map<String, String>> deregister(@PathVariable String masterId) {
        registryService.deregister(masterId);
        return ResponseEntity.ok(Map.of("status", "deregistered"));
    }

    @GetMapping
    public ResponseEntity<List<MasterNode>> listMasters() {
        return ResponseEntity.ok(registryService.getActiveMasters());
    }
}
