package com.sailer.agenticos.agenticnetvault.rest;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.vault.VaultException;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests for {@link GlobalExceptionHandler} — this is a secrets service, so how it turns exceptions into HTTP
 * responses is a security boundary, not just ergonomics. The contract these pin: a client-side
 * {@link IllegalArgumentException} may surface its message (it's the caller's own validation error), but a
 * backend {@link VaultException} and any unexpected exception must map to a fixed, generic body that leaks
 * NEITHER the backend detail NOR the raw exception message (which could carry a token, host, or path). A
 * regression that started echoing {@code ex.getMessage()} in those two handlers would exfiltrate internals.
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    void vaultExceptionMapsToBadGatewayWithoutLeakingBackendDetail() {
        String sensitive = "connect to 10.1.2.3:8200 failed, token s.ROOTabc123";
        ResponseEntity<Map<String, Object>> resp = handler.handleVaultException(new VaultException(sensitive));

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        assertThat(resp.getBody()).containsEntry("error", "OpenBao backend error");
        assertThat(resp.getBody()).containsEntry("detail", "Failed to communicate with secrets backend");
        // The raw backend message must NOT reach the client.
        assertThat(resp.getBody().get("detail").toString()).doesNotContain("10.1.2.3", "ROOTabc123", "8200");
    }

    @Test
    void illegalArgumentMapsToBadRequestAndSurfacesTheValidationMessage() {
        // Validation errors are the caller's own fault and safe to echo — this is how the client learns what to fix.
        ResponseEntity<Map<String, Object>> resp =
                handler.handleIllegalArgument(new IllegalArgumentException("modelId must not be empty"));

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(resp.getBody()).containsEntry("error", "Invalid request");
        assertThat(resp.getBody()).containsEntry("detail", "modelId must not be empty");
    }

    @Test
    void unexpectedExceptionMapsToInternalErrorWithoutLeakingMessage() {
        String sensitive = "NullPointerException at CredentialService line 42 for secret/agenticos/foo";
        ResponseEntity<Map<String, Object>> resp = handler.handleGeneral(new RuntimeException(sensitive));

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(resp.getBody()).containsEntry("error", "Internal server error");
        assertThat(resp.getBody()).containsEntry("detail", "An unexpected error occurred");
        // Stack/internal detail must never reach the client.
        assertThat(resp.getBody().get("detail").toString()).doesNotContain("CredentialService", "secret/agenticos");
    }

    @Test
    void everyErrorBodyCarriesAParseableTimestamp() {
        ResponseEntity<Map<String, Object>> resp = handler.handleGeneral(new RuntimeException("x"));
        Object ts = resp.getBody().get("timestamp");
        assertThat(ts).isInstanceOf(String.class);
        // Must be a valid ISO-8601 instant — throws if the format regressed.
        Instant.parse((String) ts);
    }
}
