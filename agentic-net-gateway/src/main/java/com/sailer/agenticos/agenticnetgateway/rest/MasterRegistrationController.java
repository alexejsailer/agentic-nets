package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService.MasterNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;

/**
 * Internal API for master node registration. Masters register themselves on startup,
 * send periodic heartbeats, and deregister on shutdown.
 *
 * <p>These endpoints are protected with the shared {@code X-Agenticos-Internal-Secret}
 * header because master registration happens before OAuth2 client credentials are available
 * to the master.</p>
 */
@RestController
@RequestMapping("/internal/masters")
public class MasterRegistrationController {

    private static final Logger logger = LoggerFactory.getLogger(MasterRegistrationController.class);
    private static final String INTERNAL_SECRET_HEADER = "X-Agenticos-Internal-Secret";

    private final MasterRegistryService registryService;
    private final GatewayProperties props;

    public MasterRegistrationController(MasterRegistryService registryService, GatewayProperties props) {
        this.registryService = registryService;
        this.props = props;
    }

    @PostMapping("/register")
    public ResponseEntity<?> register(
            @RequestHeader(name = INTERNAL_SECRET_HEADER, required = false) String internalSecret,
            @RequestBody Map<String, Object> body) {
        ResponseEntity<?> rejected = rejectIfUnauthorized(internalSecret);
        if (rejected != null) {
            return rejected;
        }

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
    public ResponseEntity<?> heartbeat(
            @RequestHeader(name = INTERNAL_SECRET_HEADER, required = false) String internalSecret,
            @RequestBody Map<String, String> body) {
        ResponseEntity<?> rejected = rejectIfUnauthorized(internalSecret);
        if (rejected != null) {
            return rejected;
        }

        String masterId = body.get("masterId");
        if (masterId == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "masterId is required"));
        }
        registryService.heartbeat(masterId);
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    @DeleteMapping("/{masterId}")
    public ResponseEntity<?> deregister(
            @RequestHeader(name = INTERNAL_SECRET_HEADER, required = false) String internalSecret,
            @PathVariable String masterId) {
        ResponseEntity<?> rejected = rejectIfUnauthorized(internalSecret);
        if (rejected != null) {
            return rejected;
        }

        registryService.deregister(masterId);
        return ResponseEntity.ok(Map.of("status", "deregistered"));
    }

    @GetMapping
    public ResponseEntity<?> listMasters(
            @RequestHeader(name = INTERNAL_SECRET_HEADER, required = false) String internalSecret) {
        ResponseEntity<?> rejected = rejectIfUnauthorized(internalSecret);
        if (rejected != null) {
            return rejected;
        }
        return ResponseEntity.ok(registryService.getActiveMasters());
    }

    private ResponseEntity<Map<String, String>> rejectIfUnauthorized(String providedSecret) {
        String expected = props.getInternalSecret();
        if (expected == null || expected.isBlank()) {
            logger.error("Gateway internal secret is not configured; refusing master registry request");
            return ResponseEntity.status(503).body(Map.of("error", "Gateway internal secret is not configured"));
        }
        if (providedSecret == null || providedSecret.isBlank() || !constantTimeEquals(expected, providedSecret)) {
            logger.warn("Rejected unauthorized master registry request");
            return ResponseEntity.status(401).body(Map.of("error", "Unauthorized"));
        }
        return null;
    }

    private boolean constantTimeEquals(String expected, String actual) {
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                actual.getBytes(StandardCharsets.UTF_8));
    }
}
