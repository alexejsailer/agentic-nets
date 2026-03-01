package com.sailer.agenticos.agenticnetexecutor.blob;

/**
 * Exception thrown when BlobStore operations fail.
 */
public class BlobStoreException extends Exception {

    public BlobStoreException(String message) {
        super(message);
    }

    public BlobStoreException(String message, Throwable cause) {
        super(message, cause);
    }
}
