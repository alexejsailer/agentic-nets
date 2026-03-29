package com.sailer.blobstore.rest;

import com.sailer.blobstore.storage.HashBasedStorageManager;
import com.sailer.blobstore.storage.StorageException;
import com.sailer.blobstore.upload.TwoPhaseUploadManager;
import com.sailer.blobstore.validation.BlobIdValidator;
import com.sailer.blobstore.validation.BlobIdValidationException;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

/**
 * REST Controller for SA-BLOBSTORE blob operations
 * Provides endpoints for blob upload, download, existence checks, and deletion
 */
@RestController
@RequestMapping("/api/blobs")
public class BlobController {
    
    private static final Logger logger = LoggerFactory.getLogger(BlobController.class);
    
    private final HashBasedStorageManager storageManager;
    private final TwoPhaseUploadManager uploadManager;
    private final BlobIdValidator blobIdValidator;
    private final Tracer tracer;

    public BlobController(HashBasedStorageManager storageManager,
                         TwoPhaseUploadManager uploadManager,
                         BlobIdValidator blobIdValidator,
                         Tracer tracer) {
        this.storageManager = storageManager;
        this.uploadManager = uploadManager;
        this.blobIdValidator = blobIdValidator;
        this.tracer = tracer;
    }

    /**
     * Upload a blob with auto-generated ID
     * POST /api/blobs
     *
     * ID generation strategies (via X-Id-Strategy header):
     * - timestamp (default): {date}/{shortUuid} - Sortable, retention-friendly
     * - uuid: {uuid} - Globally unique
     * - content-hash: sha256/{hash} - Deduplication
     *
     * Response includes a AgenticNetOS URN: urn:agenticos:blob:{blobId}
     */
    @PostMapping(consumes = MediaType.ALL_VALUE)
    public ResponseEntity<Map<String, Object>> uploadBlobAutoId(
            @RequestBody byte[] content,
            @RequestHeader(value = "Content-Type", defaultValue = "application/octet-stream") String contentType,
            @RequestHeader(value = "X-Blob-Filename", required = false) String filename,
            @RequestHeader(value = "X-Id-Strategy", defaultValue = "timestamp") String idStrategy,
            HttpServletRequest request) {

        Span span = tracer.spanBuilder("blob-controller.upload-auto-id")
                .setAttribute("id.strategy", idStrategy)
                .setAttribute("blob.size", content.length)
                .setAttribute("content.type", contentType)
                .startSpan();

        try {
            // Generate blob ID based on strategy
            String blobId = generateBlobId(idStrategy, content, filename);
            String urn = "urn:agenticos:blob:" + blobId;

            span.setAttribute("blob.id", blobId);
            span.setAttribute("blob.urn", urn);

            logger.info("Auto-ID upload request (strategy: {}, blobId: {}, {} bytes, type: {})",
                       idStrategy, blobId, content.length, contentType);

            // Calculate content hash for integrity
            String contentHash = calculateSHA256(content);
            span.setAttribute("content.hash", contentHash);

            // Store the blob
            Path blobPath = storageManager.getBlobPath(blobId);
            storageManager.ensureDirectories(blobPath);
            Files.write(blobPath, content);
            span.setAttribute("storage.path", blobPath.toString());

            // Generate ETag from content hash
            String etag = "\"" + contentHash + "\"";

            // Build download URL
            String downloadUrl = request.getRequestURL().toString() + "/" + blobId;

            // Build response with URN
            Map<String, Object> response = new HashMap<>();
            response.put("blobId", blobId);
            response.put("urn", urn);
            response.put("size", content.length);
            response.put("contentType", contentType);
            response.put("sha256", contentHash);
            response.put("uploadedAt", Instant.now().toString());
            response.put("downloadUrl", downloadUrl);
            response.put("status", "uploaded");
            if (filename != null) {
                response.put("filename", filename);
            }

            logger.info("Successfully uploaded blob {} (URN: {}) to {}", blobId, urn, blobPath);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);

            return ResponseEntity
                .status(HttpStatus.CREATED)
                .header(HttpHeaders.ETAG, etag)
                .header("X-Blob-Id", blobId)
                .header("X-Blob-URN", urn)
                .header("X-Storage-Path", blobPath.toString())
                .body(response);

        } catch (StorageException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Storage error");
            logger.error("Storage error for auto-ID blob: {}", e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                "Storage error: " + e.getMessage());

        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Unexpected error");
            logger.error("Unexpected error uploading auto-ID blob: {}", e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                "Upload failed: " + e.getMessage());

        } finally {
            span.end();
        }
    }

    /**
     * Generate a blob ID based on the specified strategy.
     * All IDs must be at least 36 characters to pass validation (UUID length requirement).
     *
     * @param strategy ID generation strategy: "timestamp", "uuid", or "content-hash"
     * @param content The blob content (used for content-hash strategy)
     * @param filename Optional filename hint
     * @return Generated blob ID (minimum 36 characters)
     */
    private String generateBlobId(String strategy, byte[] content, String filename) {
        return switch (strategy.toLowerCase()) {
            case "uuid" -> UUID.randomUUID().toString();
            case "content-hash" -> {
                // sha256/ + 32 chars = 39 chars total (meets 36 char min)
                String hash = calculateSHA256(content);
                yield "sha256/" + hash.substring(0, 32);
            }
            default -> { // "timestamp" is the default
                // Format: YYYY-MM-DD/UUID = 10 + 1 + 36 = 47 chars (meets 36 char min)
                String date = LocalDate.now().toString();
                String uuid = UUID.randomUUID().toString();
                yield date + "/" + uuid;
            }
        };
    }

    /**
     * Upload a blob with client-provided ID
     * POST /api/blobs/{blobId}
     */
    @PostMapping(value = "/**")
    public ResponseEntity<Map<String, Object>> uploadBlob(
            @RequestBody byte[] content,
            @RequestHeader(value = "Content-Type", defaultValue = "application/octet-stream") String contentType,
            HttpServletRequest request) {
        
        // Extract blob ID from request path
        String requestURI = request.getRequestURI();
        String blobId = requestURI.substring("/api/blobs/".length());
        
        Span span = tracer.spanBuilder("blob-controller.upload")
                .setAttribute("blob.id", blobId)
                .setAttribute("blob.size", content.length)
                .setAttribute("content.type", contentType)
                .startSpan();
        
        try {
            logger.info("Upload request for blob {} ({} bytes, type: {})", 
                       blobId, content.length, contentType);
            
            // Validate blob ID
            blobIdValidator.validateBlobId(blobId);
            span.setAttribute("validation.passed", true);
            
            // Calculate content hash for integrity
            String contentHash = calculateSHA256(content);
            span.setAttribute("content.hash", contentHash);
            
            // Simple upload directly to storage (temporary approach)
            Path blobPath = storageManager.getBlobPath(blobId);
            storageManager.ensureDirectories(blobPath);
            Files.write(blobPath, content);
            Path storedPath = blobPath;
            span.setAttribute("storage.path", storedPath.toString());
            
            // Generate ETag from content hash
            String etag = "\"" + contentHash + "\"";
            
            // Build response
            Map<String, Object> response = Map.of(
                "blobId", blobId,
                "size", content.length,
                "contentType", contentType,
                "etag", etag,
                "uploadedAt", Instant.now().toString(),
                "status", "uploaded"
            );
            
            logger.info("Successfully uploaded blob {} to {}", blobId, storedPath);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);
            
            return ResponseEntity
                .status(HttpStatus.CREATED)
                .header(HttpHeaders.ETAG, etag)
                .header("X-Blob-Id", blobId)
                .header("X-Storage-Path", storedPath.toString())
                .body(response);
                
        } catch (BlobIdValidationException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Invalid blob ID");
            logger.warn("Invalid blob ID {}: {}", blobId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, 
                "Invalid blob ID: " + e.getMessage());
                
        } catch (StorageException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Storage error");
            logger.error("Storage error for blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Storage error: " + e.getMessage());
                
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Unexpected error");
            logger.error("Unexpected error uploading blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Upload failed: " + e.getMessage());
                
        } finally {
            span.end();
        }
    }

    /**
     * Download a blob
     * GET /api/blobs/{blobId}
     */
    @GetMapping("/**")
    public ResponseEntity<Resource> downloadBlob(HttpServletRequest request) {
        
        // Extract blob ID from request path
        String requestURI = request.getRequestURI();
        String blobId = requestURI.substring("/api/blobs/".length());
        
        Span span = tracer.spanBuilder("blob-controller.download")
                .setAttribute("blob.id", blobId)
                .startSpan();
        
        try {
            logger.debug("Download request for blob {}", blobId);
            
            // Validate blob ID
            blobIdValidator.validateBlobId(blobId);
            span.setAttribute("validation.passed", true);
            
            // Get blob path from storage manager
            Path blobPath = storageManager.getBlobPath(blobId);
            span.setAttribute("storage.path", blobPath.toString());
            
            if (!Files.exists(blobPath)) {
                span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Blob not found");
                logger.debug("Blob {} not found at {}", blobId, blobPath);
                return ResponseEntity.notFound().build();
            }
            
            // Read blob content
            byte[] content = Files.readAllBytes(blobPath);
            span.setAttribute("blob.size", content.length);
            
            // Determine content type (could be stored as metadata in the future)
            String contentType = determineContentType(blobPath, content);
            span.setAttribute("content.type", contentType);
            
            // Calculate ETag from content
            String etag = "\"" + calculateSHA256(content) + "\"";
            
            // Create resource
            Resource resource = new ByteArrayResource(content);
            
            logger.debug("Successfully serving blob {} ({} bytes)", blobId, content.length);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);
            
            return ResponseEntity.ok()
                .header(HttpHeaders.ETAG, etag)
                .header("X-Blob-Id", blobId)
                .header("X-Storage-Path", blobPath.toString())
                .contentType(MediaType.parseMediaType(contentType))
                .contentLength(content.length)
                .body(resource);
                
        } catch (BlobIdValidationException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Invalid blob ID");
            logger.warn("Invalid blob ID {}: {}", blobId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, 
                "Invalid blob ID: " + e.getMessage());
                
        } catch (NoSuchFileException e) {
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Blob not found");
            logger.debug("Blob {} not found", blobId);
            return ResponseEntity.notFound().build();
                
        } catch (IOException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "IO error");
            logger.error("IO error reading blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Error reading blob: " + e.getMessage());
                
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Unexpected error");
            logger.error("Unexpected error downloading blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Download failed: " + e.getMessage());
                
        } finally {
            span.end();
        }
    }

    /**
     * Check if a blob exists
     * HEAD /api/blobs/{blobId}
     */
    @RequestMapping(value = "/**", method = RequestMethod.HEAD)
    public ResponseEntity<Void> checkBlobExists(HttpServletRequest request) {
        
        // Extract blob ID from request path
        String requestURI = request.getRequestURI();
        String blobId = requestURI.substring("/api/blobs/".length());
        
        Span span = tracer.spanBuilder("blob-controller.exists")
                .setAttribute("blob.id", blobId)
                .startSpan();
        
        try {
            logger.debug("Existence check for blob {}", blobId);
            
            // Validate blob ID
            blobIdValidator.validateBlobId(blobId);
            span.setAttribute("validation.passed", true);
            
            // Get blob path from storage manager
            Path blobPath = storageManager.getBlobPath(blobId);
            span.setAttribute("storage.path", blobPath.toString());
            
            if (!Files.exists(blobPath)) {
                span.setAttribute("blob.exists", false);
                logger.debug("Blob {} does not exist at {}", blobId, blobPath);
                return ResponseEntity.notFound().build();
            }
            
            // Get file info for headers
            long size = Files.size(blobPath);
            span.setAttribute("blob.size", size);
            span.setAttribute("blob.exists", true);
            
            // Calculate ETag if file is small enough (avoid reading large files for HEAD)
            String etag = null;
            if (size <= 1024 * 1024) { // 1MB threshold
                byte[] content = Files.readAllBytes(blobPath);
                etag = "\"" + calculateSHA256(content) + "\"";
            }
            
            logger.debug("Blob {} exists ({} bytes)", blobId, size);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);
            
            ResponseEntity.BodyBuilder responseBuilder = ResponseEntity.ok()
                .header("X-Blob-Id", blobId)
                .header("X-Storage-Path", blobPath.toString())
                .contentLength(size);
                
            if (etag != null) {
                responseBuilder.header(HttpHeaders.ETAG, etag);
            }
                
            return responseBuilder.build();
                
        } catch (BlobIdValidationException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Invalid blob ID");
            logger.warn("Invalid blob ID {}: {}", blobId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, 
                "Invalid blob ID: " + e.getMessage());
                
        } catch (IOException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "IO error");
            logger.error("IO error checking blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Error checking blob: " + e.getMessage());
                
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Unexpected error");
            logger.error("Unexpected error checking blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Existence check failed: " + e.getMessage());
                
        } finally {
            span.end();
        }
    }

    /**
     * Delete a blob
     * DELETE /api/blobs/{blobId}
     */
    @DeleteMapping("/**")
    public ResponseEntity<Map<String, Object>> deleteBlob(HttpServletRequest request) {
        
        // Extract blob ID from request path
        String requestURI = request.getRequestURI();
        String blobId = requestURI.substring("/api/blobs/".length());
        
        Span span = tracer.spanBuilder("blob-controller.delete")
                .setAttribute("blob.id", blobId)
                .startSpan();
        
        try {
            logger.info("Delete request for blob {}", blobId);
            
            // Validate blob ID
            blobIdValidator.validateBlobId(blobId);
            span.setAttribute("validation.passed", true);
            
            // Get blob path from storage manager
            Path blobPath = storageManager.getBlobPath(blobId);
            span.setAttribute("storage.path", blobPath.toString());
            
            boolean existed = Files.exists(blobPath);
            span.setAttribute("blob.existed", existed);
            
            if (!existed) {
                logger.debug("Blob {} does not exist, returning 404", blobId);
                span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Blob not found");
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, 
                    "Blob not found: " + blobId);
            }
            
            // Delete the blob file
            boolean deleted = Files.deleteIfExists(blobPath);
            span.setAttribute("blob.deleted", deleted);
            
            if (deleted) {
                logger.info("Successfully deleted blob {} from {}", blobId, blobPath);
                span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);
                
                Map<String, Object> response = Map.of(
                    "blobId", blobId,
                    "deleted", true,
                    "deletedAt", Instant.now().toString(),
                    "status", "deleted"
                );
                
                return ResponseEntity.ok()
                    .header("X-Blob-Id", blobId)
                    .body(response);
            } else {
                logger.warn("Failed to delete blob {} from {}", blobId, blobPath);
                span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Delete failed");
                throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                    "Failed to delete blob: " + blobId);
            }
                
        } catch (BlobIdValidationException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Invalid blob ID");
            logger.warn("Invalid blob ID {}: {}", blobId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, 
                "Invalid blob ID: " + e.getMessage());
                
        } catch (IOException e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "IO error");
            logger.error("IO error deleting blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Error deleting blob: " + e.getMessage());
                
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, "Unexpected error");
            logger.error("Unexpected error deleting blob {}: {}", blobId, e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, 
                "Delete failed: " + e.getMessage());
                
        } finally {
            span.end();
        }
    }

    // Helper methods

    private String calculateSHA256(byte[] content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(content);
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            logger.warn("SHA-256 not available, using simple hash", e);
            return String.valueOf(content.length + content.hashCode());
        }
    }

    private String determineContentType(Path path, byte[] content) {
        try {
            // Try to determine from file extension or content
            String detectedType = Files.probeContentType(path);
            if (detectedType != null) {
                return detectedType;
            }
        } catch (IOException e) {
            logger.debug("Could not probe content type for {}", path, e);
        }
        
        // Simple content type detection based on content
        if (content.length > 0) {
            // Check for common file signatures
            if (content.length >= 4) {
                // PNG signature
                if (content[0] == (byte)0x89 && content[1] == 'P' && content[2] == 'N' && content[3] == 'G') {
                    return "image/png";
                }
                // JPEG signature
                if (content[0] == (byte)0xFF && content[1] == (byte)0xD8) {
                    return "image/jpeg";
                }
                // PDF signature
                if (content[0] == '%' && content[1] == 'P' && content[2] == 'D' && content[3] == 'F') {
                    return "application/pdf";
                }
            }
            
            // Check if it's likely text
            boolean isText = true;
            int sampleSize = Math.min(512, content.length);
            for (int i = 0; i < sampleSize; i++) {
                byte b = content[i];
                if (b < 32 && b != 9 && b != 10 && b != 13) { // Not printable, tab, LF, or CR
                    isText = false;
                    break;
                }
            }
            
            if (isText) {
                return "text/plain";
            }
        }
        
        return "application/octet-stream";
    }
}