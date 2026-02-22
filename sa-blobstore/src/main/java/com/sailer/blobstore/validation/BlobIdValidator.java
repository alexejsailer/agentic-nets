package com.sailer.blobstore.validation;

import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * Azure Blob Storage Compatible ID Validator
 * 
 * Validates blob IDs to ensure they are compatible with Azure Blob Storage naming conventions,
 * which are stricter than S3 and therefore provide compatibility with both Azure Blob Storage,
 * Amazon S3, and Unix filesystem names. This enables future cloud storage backend integration
 * without requiring ID format changes.
 */
@Component
public class BlobIdValidator {

    private static final int MIN_LENGTH = 36; // UUID length
    private static final int MAX_LENGTH = 1024; // Azure Blob Storage limit
    private static final int MAX_UTF8_BYTES = 1024; // Azure UTF-8 limit
    
    // Azure Blob Storage compatible pattern: alphanumeric + hyphen + underscore + dot + forward slash
    // Note: Azure is more restrictive than S3, so this ensures compatibility with both
    private static final Pattern VALID_PATTERN = 
        Pattern.compile("^[a-zA-Z0-9._/-]{" + MIN_LENGTH + "," + MAX_LENGTH + "}$");
    
    // Azure reserved blob names that should be rejected
    private static final String[] AZURE_RESERVED_NAMES = {
        ".", "..", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "PRN", "AUX", "NUL", "CON"
    };

    /**
     * Validates a blob ID for Azure Blob Storage, S3, and filesystem compatibility
     * 
     * @param blobId The blob ID to validate
     * @throws BlobIdValidationException if the ID is invalid
     */
    public void validateBlobId(String blobId) {
        if (blobId == null || blobId.isEmpty()) {
            throw new BlobIdValidationException("Blob ID cannot be null or empty");
        }

        // Length validation
        validateLength(blobId);
        
        // UTF-8 byte length check (Azure/S3 requirement)
        validateUtf8ByteLength(blobId);
        
        // Character validation
        validateCharacters(blobId);
        
        // Azure Blob Storage specific rules (stricter than S3)
        validateAzureBlobRules(blobId);
        
        // Unix filesystem rules
        validateUnixRules(blobId);
    }

    private void validateLength(String blobId) {
        if (blobId.length() < MIN_LENGTH) {
            throw new BlobIdValidationException(
                String.format("Blob ID must be at least %d characters (provided: %d)", 
                    MIN_LENGTH, blobId.length()));
        }
        
        if (blobId.length() > MAX_LENGTH) {
            throw new BlobIdValidationException(
                String.format("Blob ID cannot exceed %d characters (provided: %d)", 
                    MAX_LENGTH, blobId.length()));
        }
    }

    private void validateUtf8ByteLength(String blobId) {
        int utf8ByteLength = blobId.getBytes(StandardCharsets.UTF_8).length;
        if (utf8ByteLength > MAX_UTF8_BYTES) {
            throw new BlobIdValidationException(
                String.format("Blob ID UTF-8 encoded length cannot exceed %d bytes (provided: %d)", 
                    MAX_UTF8_BYTES, utf8ByteLength));
        }
    }

    private void validateCharacters(String blobId) {
        if (!VALID_PATTERN.matcher(blobId).matches()) {
            throw new BlobIdValidationException(
                "Blob ID contains invalid characters. " +
                "Only alphanumeric characters, hyphens, underscores, dots, and forward slashes are allowed");
        }
    }

    private void validateAzureBlobRules(String blobId) {
        // Azure Blob Storage naming rules (stricter than S3)
        
        // Cannot start with forward slash
        if (blobId.startsWith("/")) {
            throw new BlobIdValidationException("Blob ID cannot start with forward slash");
        }
        
        // Cannot end with forward slash
        if (blobId.endsWith("/")) {
            throw new BlobIdValidationException("Blob ID cannot end with forward slash");
        }
        
        // No consecutive forward slashes
        if (blobId.contains("//")) {
            throw new BlobIdValidationException("Blob ID cannot contain consecutive forward slashes");
        }
        
        // Cannot end with dot (Azure specific)
        if (blobId.endsWith(".")) {
            throw new BlobIdValidationException("Blob ID cannot end with dot (Azure Blob Storage requirement)");
        }
        
        // Cannot have consecutive dots (Azure restriction)
        if (blobId.contains("..")) {
            throw new BlobIdValidationException("Blob ID cannot contain consecutive dots (Azure Blob Storage requirement)");
        }
        
        // Check for Azure reserved names in any path component
        String[] parts = blobId.split("/");
        for (String part : parts) {
            if (isAzureReservedName(part)) {
                throw new BlobIdValidationException(
                    String.format("Blob ID cannot contain reserved name '%s' (Azure Blob Storage requirement)", part));
            }
        }
        
        // Azure blob names are case-sensitive but we validate for mixed case issues
        // This ensures better compatibility across different storage backends
        validateCaseSensitivity(blobId);
    }
    
    private boolean isAzureReservedName(String name) {
        String upperName = name.toUpperCase();
        for (String reserved : AZURE_RESERVED_NAMES) {
            if (reserved.equals(upperName)) {
                return true;
            }
            // Also check with extensions (e.g., "CON.txt" is also reserved)
            if (upperName.startsWith(reserved + ".")) {
                return true;
            }
        }
        return false;
    }
    
    private void validateCaseSensitivity(String blobId) {
        // Check for potential case sensitivity issues that could cause problems
        // across different storage systems
        String[] parts = blobId.split("/");
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            // Check if this part conflicts with any other part when case-insensitive
            for (int j = i + 1; j < parts.length; j++) {
                if (part.equalsIgnoreCase(parts[j]) && !part.equals(parts[j])) {
                    throw new BlobIdValidationException(
                        String.format("Blob ID contains case-variant duplicates: '%s' and '%s'", part, parts[j]));
                }
            }
        }
    }

    private void validateUnixRules(String blobId) {
        // Check for control characters
        char[] forbiddenChars = {'\0', '\n', '\r', '\t'};
        for (char c : forbiddenChars) {
            if (blobId.indexOf(c) != -1) {
                throw new BlobIdValidationException(
                    String.format("Blob ID cannot contain control character: 0x%02x", (int) c));
            }
        }
    }

    /**
     * Checks if a blob ID is valid without throwing exceptions
     * 
     * @param blobId The blob ID to check
     * @return true if valid, false otherwise
     */
    public boolean isValidBlobId(String blobId) {
        try {
            validateBlobId(blobId);
            return true;
        } catch (BlobIdValidationException e) {
            return false;
        }
    }

    /**
     * Creates a validation requirements object for API responses
     * 
     * @return ValidationRequirements object with current rules
     */
    public ValidationRequirements getValidationRequirements() {
        return new ValidationRequirements(
            MIN_LENGTH,
            MAX_LENGTH,
            "a-zA-Z0-9._/-",
            new String[]{
                "Cannot start or end with forward slash",
                "Cannot contain consecutive forward slashes",
                "Cannot contain '.' or '..' as path components",
                "Cannot contain control characters"
            }
        );
    }

    /**
     * Validation requirements for API responses
     */
    public record ValidationRequirements(
        int minLength,
        int maxLength,
        String allowedChars,
        String[] rules
    ) {}
}