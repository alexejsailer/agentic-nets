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
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Exposes the service build version at {@code GET /version}.
 *
 * <p>Returns the plain-text version string (e.g. {@code 0.0.1-SNAPSHOT}) as
 * declared in {@code pom.xml}. On failure to read the version, responds with
 * {@code 500 Internal Server Error} and a short plain-text error message.
 */
@RestController
public class VersionController {

    private static final Logger log = LoggerFactory.getLogger(VersionController.class);

    private final VersionService versionService;

    public VersionController(VersionService versionService) {
        this.versionService = versionService;
    }

    @Operation(
        summary = "Get service version",
        description = "Returns the Maven project version of agentic-net-vault as plain text, "
            + "read directly from pom.xml."
    )
    @ApiResponses({
        @ApiResponse(
            responseCode = "200",
            description = "Current service version",
            content = @Content(
                mediaType = MediaType.TEXT_PLAIN_VALUE,
                schema = @Schema(type = "string", example = "0.0.1-SNAPSHOT")
            )
        ),
        @ApiResponse(
            responseCode = "500",
            description = "Version could not be resolved from pom.xml",
            content = @Content(
                mediaType = MediaType.TEXT_PLAIN_VALUE,
                schema = @Schema(type = "string", example = "Unable to read version")
            )
        )
    })
    @GetMapping(value = "/version", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseEntity<String> version() {
        try {
            String version = versionService.readVersion();
            return ResponseEntity.ok()
                .contentType(MediaType.TEXT_PLAIN)
                .body(version);
        } catch (VersionReadException e) {
            log.error("Failed to read version from pom.xml", e);
            return ResponseEntity.internalServerError()
                .contentType(MediaType.TEXT_PLAIN)
                .body("Unable to read version");
        }
    }
}
