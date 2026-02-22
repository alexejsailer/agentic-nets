package com.sailer.blobstore.storage;

/**
 * Exception thrown when storage operations fail
 * 
 * This exception wraps various filesystem and storage-related
 * errors that can occur during blob storage operations.
 */
public class StorageException extends RuntimeException {

    public StorageException(String message) {
        super(message);
    }

    public StorageException(String message, Throwable cause) {
        super(message, cause);
    }
}