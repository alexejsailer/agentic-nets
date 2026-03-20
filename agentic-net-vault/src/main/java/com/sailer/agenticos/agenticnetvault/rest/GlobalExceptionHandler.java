package com.sailer.agenticos.agenticnetvault.rest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.vault.VaultException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger logger = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(VaultException.class)
    public ResponseEntity<Map<String, Object>> handleVaultException(VaultException ex) {
        logger.error("OpenBao error: {}", ex.getMessage(), ex);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(errorBody(
            "OpenBao backend error",
            "Failed to communicate with secrets backend"
        ));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleIllegalArgument(IllegalArgumentException ex) {
        return ResponseEntity.badRequest().body(errorBody(
            "Invalid request",
            ex.getMessage()
        ));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneral(Exception ex) {
        logger.error("Unexpected error: {}", ex.getMessage(), ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorBody(
            "Internal server error",
            "An unexpected error occurred"
        ));
    }

    private Map<String, Object> errorBody(String error, String detail) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", error);
        body.put("detail", detail);
        body.put("timestamp", Instant.now().toString());
        return body;
    }
}
