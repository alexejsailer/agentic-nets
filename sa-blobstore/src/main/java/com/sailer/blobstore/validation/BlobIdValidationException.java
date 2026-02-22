package com.sailer.blobstore.validation;

/**
 * Exception thrown when a blob ID fails validation
 * 
 * This exception is used to indicate that a provided blob ID
 * does not meet the S3-compatible naming requirements.
 */
public class BlobIdValidationException extends RuntimeException {

    public BlobIdValidationException(String message) {
        super(message);
    }

    public BlobIdValidationException(String message, Throwable cause) {
        super(message, cause);
    }
}