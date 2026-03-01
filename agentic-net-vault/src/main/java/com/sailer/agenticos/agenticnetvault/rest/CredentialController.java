package com.sailer.agenticos.agenticnetvault.rest;

import com.sailer.agenticos.agenticnetvault.service.CredentialService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/vault/{modelId}/transitions/{transitionId}/credentials")
@CrossOrigin(origins = "*")
public class CredentialController {

    private static final Logger logger = LoggerFactory.getLogger(CredentialController.class);

    private final CredentialService credentialService;

    public CredentialController(CredentialService credentialService) {
        this.credentialService = credentialService;
    }

    @PutMapping
    public ResponseEntity<Map<String, Object>> storeCredentials(
            @PathVariable String modelId,
            @PathVariable String transitionId,
            @RequestBody Map<String, Object> credentials) {

        if (credentials == null || credentials.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                "error", "Credentials body must not be empty",
                "modelId", modelId,
                "transitionId", transitionId
            ));
        }

        logger.info("Storing credentials for model={} transition={} ({} keys)",
            modelId, transitionId, credentials.size());

        Map<String, Object> result = credentialService.storeCredentials(modelId, transitionId, credentials);
        return ResponseEntity.ok(result);
    }

    @GetMapping
    public ResponseEntity<Map<String, Object>> readCredentials(
            @PathVariable String modelId,
            @PathVariable String transitionId) {

        Map<String, Object> result = credentialService.readCredentials(modelId, transitionId);

        if (result == null) {
            return ResponseEntity.status(404).body(notFoundResponse(modelId, transitionId));
        }

        return ResponseEntity.ok(result);
    }

    @DeleteMapping
    public ResponseEntity<Map<String, Object>> deleteCredentials(
            @PathVariable String modelId,
            @PathVariable String transitionId) {

        // Check existence first
        Map<String, Object> existing = credentialService.readCredentials(modelId, transitionId);
        if (existing == null) {
            return ResponseEntity.status(404).body(notFoundResponse(modelId, transitionId));
        }

        credentialService.deleteCredentials(modelId, transitionId);

        logger.info("Deleted credentials for model={} transition={}", modelId, transitionId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", modelId);
        result.put("transitionId", transitionId);
        result.put("deleted", true);
        return ResponseEntity.ok(result);
    }

    @GetMapping("/metadata")
    public ResponseEntity<Map<String, Object>> readMetadata(
            @PathVariable String modelId,
            @PathVariable String transitionId) {

        Map<String, Object> result = credentialService.readMetadata(modelId, transitionId);

        if (result == null) {
            return ResponseEntity.status(404).body(notFoundResponse(modelId, transitionId));
        }

        return ResponseEntity.ok(result);
    }

    private Map<String, Object> notFoundResponse(String modelId, String transitionId) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("error", "Credentials not found");
        error.put("modelId", modelId);
        error.put("transitionId", transitionId);
        return error;
    }
}
