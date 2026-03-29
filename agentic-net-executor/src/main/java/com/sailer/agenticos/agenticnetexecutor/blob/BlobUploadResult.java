package com.sailer.agenticos.agenticnetexecutor.blob;

/**
 * Result of a successful blob upload to SA-BlobStore.
 *
 * @param blobId The unique blob identifier (e.g., "2025-01-23/a1b2c3d4")
 * @param urn The AgenticNetOS URN reference (e.g., "urn:agenticos:blob:2025-01-23/a1b2c3d4")
 * @param size Size of the uploaded blob in bytes
 * @param contentType MIME type of the blob
 * @param downloadUrl URL to download the blob
 * @param sha256 SHA-256 hash of the content
 */
public record BlobUploadResult(
        String blobId,
        String urn,
        long size,
        String contentType,
        String downloadUrl,
        String sha256
) {
    /**
     * Create a minimal result with just the essential fields.
     */
    public static BlobUploadResult of(String blobId, String urn, long size) {
        return new BlobUploadResult(blobId, urn, size, null, null, null);
    }
}
