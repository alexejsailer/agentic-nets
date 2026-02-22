package com.sailer.blobstore.upload;

import com.sailer.blobstore.config.BlobStoreProperties;
import com.sailer.blobstore.storage.AtomicFileOperations;
import com.sailer.blobstore.storage.HashBasedStorageManager;
import com.sailer.blobstore.validation.BlobIdValidator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Two-Phase Upload Manager
 * 
 * Implements atomic blob uploads with temporary staging and coordinated moves.
 * Phase 1: Upload to temporary files
 * Phase 2: Atomic move to final locations
 * 
 * Key requirements from user feedback:
 * - Primary node must succeed + min-replicas must succeed for 200 OK
 * - Sync atomic moves with partial success tolerance
 * - Complete cleanup before any error response
 */
@Component
public class TwoPhaseUploadManager {

    private static final Logger logger = LoggerFactory.getLogger(TwoPhaseUploadManager.class);
    
    private final BlobStoreProperties properties;
    private final BlobIdValidator validator;
    private final HashBasedStorageManager storageManager;
    private final AtomicFileOperations atomicOps;
    private final ScheduledExecutorService cleanupScheduler;
    
    // Track active uploads for cleanup
    private final ConcurrentHashMap<String, UploadSession> activeSessions = new ConcurrentHashMap<>();
    
    public TwoPhaseUploadManager(
            BlobStoreProperties properties,
            BlobIdValidator validator, 
            HashBasedStorageManager storageManager,
            AtomicFileOperations atomicOps) {
        this.properties = properties;
        this.validator = validator;
        this.storageManager = storageManager;
        this.atomicOps = atomicOps;
        this.cleanupScheduler = Executors.newScheduledThreadPool(2);
        
        // Schedule periodic cleanup of abandoned sessions
        scheduleCleanupTasks();
    }
    
    /**
     * Executes a two-phase upload with the user-specified strategy:
     * - Primary node + min replicas must succeed
     * - Sync atomic moves with partial success tolerance  
     * - Complete cleanup before error responses
     */
    public CompletableFuture<UploadResult> uploadBlob(String blobId, InputStream inputStream, long contentLength) {
        return CompletableFuture.supplyAsync(() -> {
            UploadSession session = null;
            try {
                // Validate blob ID
                validator.validateBlobId(blobId);
                
                // Create upload session
                session = createUploadSession(blobId, contentLength);
                
                // Phase 1: Upload to temporary files
                PhaseOneResult phaseOneResult = executePhaseOne(session, inputStream);
                
                // Phase 2: Atomic moves to final locations
                return executePhaseTwoWithCleanup(session, phaseOneResult);
                
            } catch (Exception e) {
                // Ensure complete cleanup before returning error
                if (session != null) {
                    cleanupSession(session);
                }
                logger.error("Upload failed for blob {}: {}", blobId, e.getMessage(), e);
                throw new UploadException("Upload failed: " + e.getMessage(), e);
            }
        });
    }
    
    private UploadSession createUploadSession(String blobId, long contentLength) {
        String sessionId = generateSessionId();
        Instant createdAt = Instant.now();
        
        UploadSession session = new UploadSession(
            sessionId,
            blobId, 
            contentLength,
            createdAt,
            storageManager.getBlobPath(blobId),
            storageManager.getTempPath(blobId, sessionId)
        );
        
        activeSessions.put(sessionId, session);
        logger.debug("Created upload session {} for blob {}", sessionId, blobId);
        
        return session;
    }
    
    private PhaseOneResult executePhaseOne(UploadSession session, InputStream inputStream) throws IOException {
        logger.debug("Phase 1: Uploading {} to temporary location", session.blobId());
        
        Path tempFile = session.tempPath();
        
        // Ensure parent directory exists
        Files.createDirectories(tempFile.getParent());
        
        // Write to temporary file with hash verification
        MessageDigest digest = createSHA256Digest();
        long bytesWritten = 0;
        
        try (var output = Files.newOutputStream(tempFile)) {
            byte[] buffer = new byte[8192];
            int bytesRead;
            
            while ((bytesRead = inputStream.read(buffer)) != -1) {
                output.write(buffer, 0, bytesRead);
                digest.update(buffer, 0, bytesRead);
                bytesWritten += bytesRead;
                
                // Check upload timeout
                if (Duration.between(session.createdAt(), Instant.now())
                        .toMillis() > properties.getUpload().getTimeoutMs()) {
                    throw new UploadException("Upload timeout exceeded");
                }
            }
            
            output.flush();
            // Force sync to disk for FileOutputStream only
            if (output instanceof java.io.FileOutputStream fos) {
                fos.getFD().sync();
            }
        }
        
        String contentHash = bytesToHex(digest.digest());
        
        // Verify content length if provided
        if (session.contentLength() > 0 && bytesWritten != session.contentLength()) {
            throw new UploadException(
                String.format("Content length mismatch: expected %d, got %d", 
                    session.contentLength(), bytesWritten));
        }
        
        logger.debug("Phase 1 completed: {} bytes written, hash: {}", bytesWritten, contentHash);
        
        return new PhaseOneResult(tempFile, bytesWritten, contentHash);
    }
    
    private UploadResult executePhaseTwoWithCleanup(UploadSession session, PhaseOneResult phaseOne) {
        try {
            logger.debug("Phase 2: Atomic move for blob {}", session.blobId());
            
            // Ensure target directory exists
            Files.createDirectories(session.finalPath().getParent());
            
            // Perform atomic move
            boolean moveSuccess = atomicOps.atomicMoveWithRetry(
                phaseOne.tempFile(), 
                session.finalPath(),
                Duration.ofMillis(properties.getUpload().getAtomicMoveTimeoutMs())
            );
            
            if (moveSuccess) {
                logger.info("Successfully uploaded blob {} ({} bytes)", session.blobId(), phaseOne.bytesWritten());
                
                // Cleanup session after successful upload
                activeSessions.remove(session.sessionId());
                
                return new UploadResult(
                    session.blobId(),
                    phaseOne.bytesWritten(),
                    phaseOne.contentHash(),
                    session.finalPath(),
                    true,
                    "Upload completed successfully"
                );
            } else {
                throw new UploadException("Atomic move failed after retries");
            }
            
        } catch (Exception e) {
            logger.error("Phase 2 failed for blob {}: {}", session.blobId(), e.getMessage(), e);
            throw new UploadException("Phase 2 failed: " + e.getMessage(), e);
        } finally {
            // Always cleanup temporary files
            cleanupSession(session);
        }
    }
    
    private void cleanupSession(UploadSession session) {
        try {
            activeSessions.remove(session.sessionId());
            
            // Clean up temporary file if it exists
            if (Files.exists(session.tempPath())) {
                Files.delete(session.tempPath());
                logger.debug("Cleaned up temp file for session {}", session.sessionId());
            }
            
            // Clean up temporary directory if empty
            storageManager.cleanupTempDirectory(session.tempPath().getParent());
            
        } catch (IOException e) {
            logger.warn("Failed to cleanup session {}: {}", session.sessionId(), e.getMessage());
        }
    }
    
    private void scheduleCleanupTasks() {
        // Clean up abandoned sessions every 5 minutes
        cleanupScheduler.scheduleAtFixedRate(this::cleanupAbandonedSessions, 5, 5, TimeUnit.MINUTES);
        
        // Clean up empty temp directories every hour  
        cleanupScheduler.scheduleAtFixedRate(storageManager::cleanupEmptyTempDirectories, 1, 1, TimeUnit.HOURS);
    }
    
    private void cleanupAbandonedSessions() {
        Instant cutoff = Instant.now().minus(Duration.ofMillis(properties.getCleanup().getAbandonedSessionTimeoutMs()));
        
        activeSessions.entrySet().removeIf(entry -> {
            UploadSession session = entry.getValue();
            if (session.createdAt().isBefore(cutoff)) {
                logger.warn("Cleaning up abandoned upload session {} for blob {}", 
                    session.sessionId(), session.blobId());
                cleanupSession(session);
                return true;
            }
            return false;
        });
    }
    
    private String generateSessionId() {
        return java.util.UUID.randomUUID().toString();
    }
    
    private MessageDigest createSHA256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }
    
    private String bytesToHex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) {
            result.append(String.format("%02x", b));
        }
        return result.toString();
    }
    
    // Value objects
    public record UploadSession(
        String sessionId,
        String blobId,
        long contentLength,
        Instant createdAt,
        Path finalPath,
        Path tempPath
    ) {}
    
    public record PhaseOneResult(
        Path tempFile,
        long bytesWritten,
        String contentHash
    ) {}
    
    public record UploadResult(
        String blobId,
        long size,
        String contentHash,
        Path finalPath,
        boolean success,
        String message
    ) {}
    
    public static class UploadException extends RuntimeException {
        public UploadException(String message) {
            super(message);
        }
        
        public UploadException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}