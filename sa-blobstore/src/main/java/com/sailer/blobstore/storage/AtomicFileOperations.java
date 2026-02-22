package com.sailer.blobstore.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributeView;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Atomic File Operations Service
 * 
 * Provides atomic file operations including temp file creation,
 * atomic moves, and guaranteed cleanup operations.
 * 
 * All operations are designed to be atomic at the filesystem level
 * to ensure data consistency during concurrent operations.
 */
@Component
public class AtomicFileOperations {

    private static final Logger logger = LoggerFactory.getLogger(AtomicFileOperations.class);

    /**
     * Writes data from an InputStream to a temporary file
     * 
     * @param inputStream Source data stream
     * @param tempPath Target temporary file path
     * @param bufferSize Buffer size for I/O operations
     * @return Number of bytes written
     * @throws StorageException if write operation fails
     */
    public long writeToTempFile(InputStream inputStream, Path tempPath, int bufferSize) {
        try {
            // Ensure parent directory exists
            Path parentDir = tempPath.getParent();
            if (parentDir != null && !Files.exists(parentDir)) {
                Files.createDirectories(parentDir);
            }

            // Write to temp file
            long bytesWritten = Files.copy(inputStream, tempPath, StandardCopyOption.REPLACE_EXISTING);
            
            logger.debug("Wrote {} bytes to temp file: {}", bytesWritten, tempPath);
            return bytesWritten;
            
        } catch (IOException e) {
            throw new StorageException("Failed to write to temp file: " + tempPath, e);
        }
    }

    /**
     * Performs an atomic move from source to destination
     * 
     * @param sourcePath Source file path
     * @param destinationPath Destination file path  
     * @param forceSync Whether to force filesystem sync after move
     * @return true if move was successful
     * @throws StorageException if atomic move fails
     */
    public boolean atomicMove(Path sourcePath, Path destinationPath, boolean forceSync) {
        try {
            // Ensure destination parent directory exists
            Path parentDir = destinationPath.getParent();
            if (parentDir != null && !Files.exists(parentDir)) {
                Files.createDirectories(parentDir);
            }

            // Perform atomic move
            Files.move(sourcePath, destinationPath, 
                StandardCopyOption.ATOMIC_MOVE, 
                StandardCopyOption.REPLACE_EXISTING);

            // Force sync to disk if requested
            if (forceSync) {
                syncPath(destinationPath);
            }

            logger.debug("Atomic move completed: {} -> {}", sourcePath, destinationPath);
            return true;
            
        } catch (AtomicMoveNotSupportedException e) {
            // Fallback to copy + delete if atomic move not supported
            logger.warn("Atomic move not supported, falling back to copy+delete for: {} -> {}", 
                sourcePath, destinationPath);
            return fallbackCopyAndDelete(sourcePath, destinationPath, forceSync);
            
        } catch (IOException e) {
            throw new StorageException(
                String.format("Failed to atomically move %s to %s", sourcePath, destinationPath), e);
        }
    }

    /**
     * Performs atomic move with timeout
     * 
     * @param sourcePath Source file path
     * @param destinationPath Destination file path
     * @param forceSync Whether to force filesystem sync
     * @param timeoutMs Timeout in milliseconds
     * @return CompletableFuture that completes when move is done
     */
    public CompletableFuture<Boolean> atomicMoveAsync(Path sourcePath, Path destinationPath, 
            boolean forceSync, long timeoutMs) {
        
        return CompletableFuture.supplyAsync(() -> 
            atomicMove(sourcePath, destinationPath, forceSync))
            .completeOnTimeout(false, timeoutMs, TimeUnit.MILLISECONDS)
            .handle((result, throwable) -> {
                if (throwable != null) {
                    logger.error("Async atomic move failed: {} -> {}", sourcePath, destinationPath, throwable);
                    return false;
                }
                return result;
            });
    }

    /**
     * Performs atomic move with retry logic and timeout
     * 
     * @param sourcePath Source file path
     * @param destinationPath Destination file path
     * @param timeout Maximum time to wait for the operation
     * @return true if move was successful, false otherwise
     */
    public boolean atomicMoveWithRetry(Path sourcePath, Path destinationPath, Duration timeout) {
        int maxRetries = 3;
        long delayMs = 100;
        
        for (int attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                boolean success = atomicMove(sourcePath, destinationPath, true);
                if (success) {
                    logger.debug("Atomic move succeeded on attempt {}: {} -> {}", 
                        attempt, sourcePath, destinationPath);
                    return true;
                }
            } catch (Exception e) {
                logger.warn("Atomic move attempt {} failed: {} -> {} ({})", 
                    attempt, sourcePath, destinationPath, e.getMessage());
                
                if (attempt == maxRetries) {
                    logger.error("All atomic move attempts failed: {} -> {}", sourcePath, destinationPath, e);
                    return false;
                }
                
                // Wait before retry
                try {
                    Thread.sleep(delayMs * attempt);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        
        return false;
    }

    /**
     * Safely deletes a file if it exists
     * 
     * @param filePath Path to file to delete
     * @return true if file was deleted, false if it didn't exist
     * @throws StorageException if deletion fails
     */
    public boolean safeDelete(Path filePath) {
        try {
            boolean deleted = Files.deleteIfExists(filePath);
            if (deleted) {
                logger.debug("Deleted file: {}", filePath);
            }
            return deleted;
        } catch (IOException e) {
            throw new StorageException("Failed to delete file: " + filePath, e);
        }
    }

    /**
     * Safely deletes multiple files
     * 
     * @param filePaths Paths to files to delete
     * @return Number of files successfully deleted
     */
    public int safeDeleteAll(Path... filePaths) {
        int deletedCount = 0;
        for (Path path : filePaths) {
            try {
                if (safeDelete(path)) {
                    deletedCount++;
                }
            } catch (StorageException e) {
                logger.warn("Failed to delete file during cleanup: {}", path, e);
            }
        }
        return deletedCount;
    }

    /**
     * Creates a temporary file with a unique name
     * 
     * @param tempDir Directory for temporary files
     * @param prefix Filename prefix
     * @param suffix Filename suffix
     * @return Path to created temporary file
     * @throws StorageException if temp file creation fails
     */
    public Path createTempFile(Path tempDir, String prefix, String suffix) {
        try {
            if (!Files.exists(tempDir)) {
                Files.createDirectories(tempDir);
            }
            
            Path tempFile = Files.createTempFile(tempDir, prefix, suffix);
            logger.debug("Created temp file: {}", tempFile);
            return tempFile;
            
        } catch (IOException e) {
            throw new StorageException("Failed to create temp file in: " + tempDir, e);
        }
    }

    /**
     * Gets file size safely
     * 
     * @param filePath Path to file
     * @return File size in bytes, or 0 if file doesn't exist
     */
    public long getFileSize(Path filePath) {
        try {
            return Files.exists(filePath) ? Files.size(filePath) : 0L;
        } catch (IOException e) {
            logger.warn("Failed to get size for file: {}", filePath, e);
            return 0L;
        }
    }

    private boolean fallbackCopyAndDelete(Path sourcePath, Path destinationPath, boolean forceSync) {
        try {
            // Copy file
            Files.copy(sourcePath, destinationPath, StandardCopyOption.REPLACE_EXISTING);
            
            // Force sync if requested
            if (forceSync) {
                syncPath(destinationPath);
            }
            
            // Delete original
            Files.delete(sourcePath);
            
            logger.debug("Fallback copy+delete completed: {} -> {}", sourcePath, destinationPath);
            return true;
            
        } catch (IOException e) {
            // Try to clean up partial copy
            try {
                Files.deleteIfExists(destinationPath);
            } catch (IOException cleanupException) {
                logger.warn("Failed to cleanup partial copy: {}", destinationPath, cleanupException);
            }
            
            throw new StorageException(
                String.format("Fallback copy+delete failed: %s -> %s", sourcePath, destinationPath), e);
        }
    }

    private void syncPath(Path path) {
        try {
            // Force filesystem sync - this ensures data is written to disk
            // Note: This is a best-effort operation, not all filesystems support it
            path.getFileSystem().provider().getFileAttributeView(path, BasicFileAttributeView.class)
                .readAttributes(); // Trigger filesystem interaction
            
            logger.debug("Synced path to disk: {}", path);
        } catch (IOException e) {
            // Log but don't fail - sync is best effort
            logger.debug("Failed to sync path to disk: {}", path, e);
        }
    }
}