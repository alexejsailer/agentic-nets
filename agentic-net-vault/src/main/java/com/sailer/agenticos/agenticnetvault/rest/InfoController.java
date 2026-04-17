package com.sailer.agenticos.agenticnetvault.rest;

import com.sailer.agenticos.agenticnetvault.service.VersionService;
import com.sailer.agenticos.agenticnetvault.service.VersionService.VersionReadException;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Exposes a minimal service-identity document at {@code GET /info}.
 *
 * <p>Returns JSON with the service name and the Maven project version so that
 * clients and operators can distinguish deployments without authentication.
 */
@RestController
public class InfoController {

    private static final Logger log = LoggerFactory.getLogger(InfoController.class);

    private final VersionService versionService;
    private final String applicationName;
    private final String fallbackVersion;

    public InfoController(
        VersionService versionService,
        @Value("${spring.application.name:agentic-net-vault}") String applicationName,
        @Value("${info.app.version:0.0.1-SNAPSHOT}") String fallbackVersion
    ) {
        this.versionService = versionService;
        this.applicationName = applicationName;
        this.fallbackVersion = fallbackVersion;
    }

    @Operation(
        summary = "Get service info",
        description = "Returns the service name and Maven project version as JSON."
    )
    @ApiResponses({
        @ApiResponse(
            responseCode = "200",
            description = "Service identity document",
            content = @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = ServiceInfo.class)
            )
        )
    })
    @GetMapping(value = "/info", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ServiceInfo> info() {
        String version;
        try {
            version = versionService.readVersion();
        } catch (VersionReadException e) {
            log.warn("Falling back to configured version; pom.xml read failed: {}", e.getMessage());
            version = fallbackVersion;
        }
        return ResponseEntity.ok(new ServiceInfo(applicationName, version));
    }

    /** Minimal identity payload returned by {@link #info()}. */
    public record ServiceInfo(String name, String version) {
    }
}
