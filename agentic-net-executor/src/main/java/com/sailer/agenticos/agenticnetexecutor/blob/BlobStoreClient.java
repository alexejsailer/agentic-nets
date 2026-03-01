package com.sailer.agenticos.agenticnetexecutor.blob;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * HTTP client for SA-BlobStore integration.
 *
 * Provides methods to upload binary content to BlobStore and receive URN references.
 * Used by command handlers to store binary output (PDFs, images, etc.) instead of
 * returning large inline content.
 */
@Service
public class BlobStoreClient {

    private static final Logger logger = LoggerFactory.getLogger(BlobStoreClient.class);

    private final RestTemplate restTemplate;
    private final String defaultHost;
    private final int timeoutMs;

    public BlobStoreClient(
            RestTemplate restTemplate,
            @Value("${agenticos.blobstore.default-host:http://localhost:8095}") String defaultHost,
            @Value("${agenticos.blobstore.timeout-ms:30000}") int timeoutMs) {
        this.restTemplate = restTemplate;
        this.defaultHost = defaultHost;
        this.timeoutMs = timeoutMs;
    }

    /**
     * Upload binary content to BlobStore using auto-ID generation.
     *
     * @param host BlobStore host URL (null to use default)
     * @param content Binary content to upload
     * @param contentType MIME type of the content
     * @param idStrategy ID generation strategy: "timestamp", "uuid", or "content-hash"
     * @param filename Optional filename hint
     * @return Upload result containing blobId, URN, and size
     * @throws BlobStoreException if upload fails
     */
    public BlobUploadResult upload(String host, byte[] content, String contentType,
                                   String idStrategy, String filename) throws BlobStoreException {
        String targetHost = (host != null && !host.isBlank()) ? host : defaultHost;
        String uploadUrl = targetHost + "/api/blobs";

        logger.debug("Uploading {} bytes to BlobStore at {} (strategy: {}, type: {})",
                    content.length, uploadUrl, idStrategy, contentType);

        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.parseMediaType(contentType));
            headers.set("X-Id-Strategy", idStrategy != null ? idStrategy : "timestamp");
            if (filename != null && !filename.isBlank()) {
                headers.set("X-Blob-Filename", filename);
            }

            HttpEntity<byte[]> request = new HttpEntity<>(content, headers);

            ResponseEntity<Map> response = restTemplate.exchange(
                    uploadUrl,
                    HttpMethod.POST,
                    request,
                    Map.class
            );

            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                throw new BlobStoreException("Upload failed with status: " + response.getStatusCode());
            }

            Map<String, Object> body = response.getBody();

            String blobId = (String) body.get("blobId");
            String urn = (String) body.get("urn");
            long size = ((Number) body.getOrDefault("size", content.length)).longValue();
            String returnedContentType = (String) body.getOrDefault("contentType", contentType);
            String downloadUrl = (String) body.get("downloadUrl");
            String sha256 = (String) body.get("sha256");

            logger.info("Successfully uploaded blob {} ({} bytes) to BlobStore: {}",
                       blobId, size, urn);

            return new BlobUploadResult(
                    blobId,
                    urn,
                    size,
                    returnedContentType,
                    downloadUrl,
                    sha256
            );

        } catch (BlobStoreException e) {
            throw e;
        } catch (Exception e) {
            logger.error("Failed to upload to BlobStore at {}: {}", uploadUrl, e.getMessage());
            throw new BlobStoreException("BlobStore upload failed: " + e.getMessage(), e);
        }
    }

    /**
     * Upload a file to BlobStore.
     *
     * @param host BlobStore host URL (null to use default)
     * @param filePath Path to the file to upload
     * @param idStrategy ID generation strategy
     * @return Upload result
     * @throws BlobStoreException if upload fails
     */
    public BlobUploadResult uploadFile(String host, Path filePath, String idStrategy)
            throws BlobStoreException {
        try {
            byte[] content = Files.readAllBytes(filePath);
            String contentType = Files.probeContentType(filePath);
            if (contentType == null) {
                contentType = "application/octet-stream";
            }
            String filename = filePath.getFileName().toString();

            return upload(host, content, contentType, idStrategy, filename);

        } catch (BlobStoreException e) {
            throw e;
        } catch (Exception e) {
            logger.error("Failed to read file for upload: {}", filePath, e);
            throw new BlobStoreException("Failed to read file: " + e.getMessage(), e);
        }
    }

    /**
     * Check if a blob exists in BlobStore.
     *
     * @param host BlobStore host URL (null to use default)
     * @param blobId The blob ID to check
     * @return true if the blob exists
     */
    public boolean exists(String host, String blobId) {
        String targetHost = (host != null && !host.isBlank()) ? host : defaultHost;
        String checkUrl = targetHost + "/api/blobs/" + blobId;

        try {
            ResponseEntity<Void> response = restTemplate.exchange(
                    checkUrl,
                    HttpMethod.HEAD,
                    null,
                    Void.class
            );
            return response.getStatusCode().is2xxSuccessful();
        } catch (Exception e) {
            logger.debug("Blob existence check failed for {}: {}", blobId, e.getMessage());
            return false;
        }
    }

    /**
     * Get the default BlobStore host.
     */
    public String getDefaultHost() {
        return defaultHost;
    }
}
