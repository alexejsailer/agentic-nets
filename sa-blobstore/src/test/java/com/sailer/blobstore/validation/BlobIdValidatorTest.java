package com.sailer.blobstore.validation;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for Azure Blob Storage compatible blob ID validation
 */
class BlobIdValidatorTest {

    private BlobIdValidator validator;

    @BeforeEach
    void setUp() {
        validator = new BlobIdValidator();
    }

    @Test
    void testValidBlobIds() {
        // Valid UUIDs and hierarchical names
        assertDoesNotThrow(() -> validator.validateBlobId("550e8400-e29b-41d4-a716-446655440000"));
        assertDoesNotThrow(() -> validator.validateBlobId("user123/documents/invoice-2024-01-15.pdf"));
        assertDoesNotThrow(() -> validator.validateBlobId("images/thumbnails/profile_pic_user456.jpg"));
        assertDoesNotThrow(() -> validator.validateBlobId("logs/application/2024/01/15/app-log.txt"));
        assertDoesNotThrow(() -> validator.validateBlobId("backups/database_dump_2024-01-15_10-30-00.sql"));
    }

    @Test
    void testInvalidBlobIds_TooShort() {
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId("short-id"));
        assertTrue(exception.getMessage().contains("at least 36 characters"));
    }

    @Test
    void testInvalidBlobIds_StartsWithSlash() {
        String testId = "/user/documents/file.pdf" + "a".repeat(15); // 23 + 15 = 38 chars, starts with /
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId));
        assertTrue(exception.getMessage().contains("cannot start with forward slash"));
    }

    @Test
    void testInvalidBlobIds_EndsWithSlash() {
        String testId = "user/documents/file.pdf" + "a".repeat(13) + "/"; // 22 + 13 + 1 = 36 chars, ends with /
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId));
        assertTrue(exception.getMessage().contains("cannot end with forward slash"));
    }

    @Test
    void testInvalidBlobIds_EndsWithDot_AzureRestriction() {
        String testId = "user/documents/report" + "a".repeat(15) + "."; // 36 chars, ends with .
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId));
        assertTrue(exception.getMessage().contains("cannot end with dot"));
    }

    @Test
    void testInvalidBlobIds_ConsecutiveDots_AzureRestriction() {
        String testId = "user/documents/file..backup" + "a".repeat(9); // 27 + 9 = 36 chars
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId));
        assertTrue(exception.getMessage().contains("consecutive dots"));
    }

    @Test
    void testInvalidBlobIds_ConsecutiveSlashes() {
        String testId = "user//documents/file.pdf" + "a".repeat(12); // 24 + 12 = 36 chars
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId));
        assertTrue(exception.getMessage().contains("consecutive forward slashes"));
    }

    @Test
    void testInvalidBlobIds_AzureReservedNames() {
        // Test Azure reserved names
        String testId1 = "user/CON/document.pdf" + "a".repeat(15); // 21 + 15 = 36 chars
        BlobIdValidationException exception1 = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId1));
        assertTrue(exception1.getMessage().contains("reserved name"));

        String testId2 = "user/documents/LPT1.txt" + "a".repeat(13); // 23 + 13 = 36 chars
        BlobIdValidationException exception2 = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId2));
        assertTrue(exception2.getMessage().contains("reserved name"));

        String testId3 = "user/documents/COM1.txt" + "a".repeat(13); // 23 + 13 = 36 chars
        BlobIdValidationException exception3 = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId3));
        assertTrue(exception3.getMessage().contains("reserved name"));
    }

    @Test
    void testInvalidBlobIds_CaseVariantDuplicates() {
        String testId = "abc/ABC/def/ghi/jkl/mno/pqr/stu/vwxy"; // 36 chars with case duplicates
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId));
        assertTrue(exception.getMessage().contains("case-variant duplicates"));
    }

    @Test
    void testInvalidBlobIds_InvalidCharacters() {
        // Create a long enough string with invalid characters (spaces)
        String testId = "file with spaces and more text here to reach length";
        BlobIdValidationException exception = assertThrows(BlobIdValidationException.class,
            () -> validator.validateBlobId(testId));
        assertTrue(exception.getMessage().contains("invalid characters"));
    }

    // Note: Control character test is not feasible because the regex validation 
    // runs before Unix validation, so control characters fail on character validation first

    @Test
    void testIsValidBlobId() {
        assertTrue(validator.isValidBlobId("550e8400-e29b-41d4-a716-446655440000"));
        assertFalse(validator.isValidBlobId("short"));
        assertFalse(validator.isValidBlobId("/starts/with/slash" + "a".repeat(16))); // 18 + 16 = 34, still too short
        assertFalse(validator.isValidBlobId("ends/with/dot." + "a".repeat(21))); // 14 + 21 = 35, still too short
    }

    @Test
    void testGetValidationRequirements() {
        BlobIdValidator.ValidationRequirements requirements = validator.getValidationRequirements();
        assertEquals(36, requirements.minLength());
        assertEquals(1024, requirements.maxLength());
        assertEquals("a-zA-Z0-9._/-", requirements.allowedChars());
        assertTrue(requirements.rules().length > 0);
    }
}