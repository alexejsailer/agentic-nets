package com.sailer.blobstore.storage;

import com.sailer.blobstore.config.BlobStoreProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Hash-Based Storage Manager
 * 
 * Manages the hash-based directory structure for blob storage.
 * Files are organized using SHA-256 hash prefixes to ensure
 * even distribution and prevent filesystem performance issues.
 * 
 * Directory Structure:
 * /app/data/
 * ├── temp/                    # Temporary staging area  
 * │   └── upload-{uuid}.tmp    # Upload staging files
 * └── aa/                      # Hash-based organization
 *     └── 12/                  # Configurable depth
 *         └── bf/              # Configurable chars per level
 *             └── blobId.blob  # Final file storage
 */
@Component
public class HashBasedStorageManager {

    private static final Logger logger = LoggerFactory.getLogger(HashBasedStorageManager.class);
    
    private final BlobStoreProperties properties;
    private final Path basePath;
    private final Path tempPath;
    
    public HashBasedStorageManager(BlobStoreProperties properties) {
        this.properties = properties;
        this.basePath = Paths.get(properties.getStorage().getPath());
        this.tempPath = basePath.resolve("temp");
        
        initializeDirectories();
    }

    /**
     * Calculates the storage path for a given blob ID
     * 
     * @param blobId The blob identifier
     * @return Path where the blob should be stored
     */
    public Path getBlobPath(String blobId) {
        String hash = calculateSHA256(blobId);
        return buildHashedPath(hash, sanitizeBlobId(blobId) + ".blob");
    }

    /**
     * Calculates the temporary storage path for uploads
     * 
     * @param uploadId Unique upload identifier
     * @return Path for temporary file storage
     */
    public Path getTempPath(String uploadId) {
        return tempPath.resolve("upload-" + uploadId + ".tmp");
    }
    
    /**
     * Calculates the temporary storage path for a specific blob upload session
     * 
     * @param blobId The blob identifier
     * @param sessionId The upload session identifier
     * @return Path for temporary file storage during upload
     */
    public Path getTempPath(String blobId, String sessionId) {
        String sanitizedBlobId = sanitizeBlobId(blobId);
        return tempPath.resolve("blob-" + sanitizedBlobId + "-" + sessionId + ".tmp");
    }

    /**
     * Calculates the temporary replication path
     * 
     * @param replicationId Unique replication identifier
     * @return Path for temporary replication storage
     */
    public Path getTempReplicationPath(String replicationId) {
        return tempPath.resolve("replication-" + replicationId + ".tmp");
    }

    /**
     * Creates all necessary parent directories for a given path
     * 
     * @param path The file path that needs parent directories
     * @throws StorageException if directory creation fails
     */
    public void ensureDirectories(Path path) {
        try {
            Path parent = path.getParent();
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent);
                logger.debug("Created directory structure: {}", parent);
            }
        } catch (IOException e) {
            throw new StorageException("Failed to create directories for path: " + path, e);
        }
    }

    /**
     * Checks if a blob file exists at the calculated path
     * 
     * @param blobId The blob identifier
     * @return true if the blob exists, false otherwise
     */
    public boolean blobExists(String blobId) {
        Path blobPath = getBlobPath(blobId);
        return Files.exists(blobPath) && Files.isRegularFile(blobPath);
    }

    /**
     * Gets the size of a blob file
     * 
     * @param blobId The blob identifier
     * @return File size in bytes
     * @throws StorageException if file doesn't exist or size cannot be determined
     */
    public long getBlobSize(String blobId) {
        Path blobPath = getBlobPath(blobId);
        try {
            if (!Files.exists(blobPath)) {
                throw new StorageException("Blob not found: " + blobId);
            }
            return Files.size(blobPath);
        } catch (IOException e) {
            throw new StorageException("Failed to get size for blob: " + blobId, e);
        }
    }

    /**
     * Deletes a blob file if it exists
     * 
     * @param blobId The blob identifier
     * @return true if file was deleted, false if it didn't exist
     * @throws StorageException if deletion fails
     */
    public boolean deleteBlob(String blobId) {
        Path blobPath = getBlobPath(blobId);
        try {
            boolean deleted = Files.deleteIfExists(blobPath);
            if (deleted) {
                logger.debug("Deleted blob: {} at path: {}", blobId, blobPath);
                // Try to clean up empty parent directories
                cleanupEmptyDirectories(blobPath.getParent());
            }
            return deleted;
        } catch (IOException e) {
            throw new StorageException("Failed to delete blob: " + blobId, e);
        }
    }

    /**
     * Cleans up temporary files older than the configured max age
     * 
     * @return Number of files cleaned up
     */
    public int cleanupOldTempFiles() {
        if (!Files.exists(tempPath)) {
            return 0;
        }

        long maxAge = properties.getCleanup().getTempFileMaxAge();
        long cutoffTime = System.currentTimeMillis() - maxAge;
        int cleanedUp = 0;

        try {
            cleanedUp = (int) Files.walk(tempPath)
                .filter(Files::isRegularFile)
                .filter(path -> {
                    try {
                        return Files.getLastModifiedTime(path).toMillis() < cutoffTime;
                    } catch (IOException e) {
                        logger.warn("Failed to get last modified time for: {}", path, e);
                        return false;
                    }
                })
                .peek(path -> {
                    try {
                        Files.delete(path);
                        logger.debug("Cleaned up old temp file: {}", path);
                    } catch (IOException e) {
                        logger.warn("Failed to delete old temp file: {}", path, e);
                    }
                })
                .count();
                
            if (cleanedUp > 0) {
                logger.info("Cleaned up {} old temporary files", cleanedUp);
            }
            
        } catch (IOException e) {
            logger.error("Failed to cleanup old temp files", e);
        }

        return cleanedUp;
    }

    private void initializeDirectories() {
        try {
            // Create base directory
            if (!Files.exists(basePath)) {
                Files.createDirectories(basePath);
                logger.info("Created base storage directory: {}", basePath);
            }
            
            // Create temp directory
            if (!Files.exists(tempPath)) {
                Files.createDirectories(tempPath);
                logger.info("Created temp storage directory: {}", tempPath);
            }
            
        } catch (IOException e) {
            throw new StorageException("Failed to initialize storage directories", e);
        }
    }

    private String calculateSHA256(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = digest.digest(input.getBytes());
            
            // Convert to hex string
            StringBuilder hexString = new StringBuilder();
            for (byte b : hashBytes) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) {
                    hexString.append('0');
                }
                hexString.append(hex);
            }
            return hexString.toString();
            
        } catch (NoSuchAlgorithmException e) {
            throw new StorageException("SHA-256 algorithm not available", e);
        }
    }

    private Path buildHashedPath(String hash, String filename) {
        Path path = basePath;
        
        int depth = properties.getHash().getDepth();
        int charsPerLevel = properties.getHash().getCharsPerLevel();
        
        // Build nested directory structure based on hash
        for (int i = 0; i < depth && (i * charsPerLevel) < hash.length(); i++) {
            int start = i * charsPerLevel;
            int end = Math.min(start + charsPerLevel, hash.length());
            String levelDir = hash.substring(start, end);
            path = path.resolve(levelDir);
        }
        
        return path.resolve(filename);
    }

    private String sanitizeBlobId(String blobId) {
        // Replace forward slashes with underscores for filesystem safety
        // This allows hierarchical blob IDs while keeping filesystem compatibility
        return blobId.replace("/", "_");
    }

    /**
     * Clean up a temporary directory if it's empty
     * 
     * @param directory The directory to clean up
     */
    public void cleanupTempDirectory(Path directory) {
        cleanupEmptyDirectories(directory);
    }
    
    /**
     * Clean up all empty temporary directories
     * Used by scheduled cleanup tasks
     */
    public void cleanupEmptyTempDirectories() {
        try {
            if (Files.exists(tempPath)) {
                Files.walk(tempPath)
                    .filter(Files::isDirectory)
                    .filter(dir -> !dir.equals(tempPath)) // Don't delete the root temp directory
                    .sorted(java.util.Comparator.reverseOrder()) // Delete deepest directories first
                    .forEach(this::cleanupEmptyDirectories);
            }
        } catch (IOException e) {
            logger.warn("Failed to cleanup empty temp directories", e);
        }
    }

    private void cleanupEmptyDirectories(Path directory) {
        try {
            // Only clean up directories within our hash structure
            if (directory != null && directory.startsWith(basePath) && !directory.equals(basePath)) {
                if (Files.exists(directory) && isDirectoryEmpty(directory)) {
                    Files.delete(directory);
                    logger.debug("Cleaned up empty directory: {}", directory);
                    // Recursively clean up parent directories
                    cleanupEmptyDirectories(directory.getParent());
                }
            }
        } catch (IOException e) {
            // Log but don't fail - empty directory cleanup is not critical
            logger.debug("Failed to cleanup empty directory: {}", directory, e);
        }
    }

    private boolean isDirectoryEmpty(Path directory) {
        try {
            return Files.list(directory).findFirst().isEmpty();
        } catch (IOException e) {
            return false;
        }
    }

    // Getters for testing and monitoring
    public Path getBasePath() { return basePath; }
    public Path getStorageRoot() { return basePath; }
    public Path getTempPath() { return tempPath; }
    public BlobStoreProperties getProperties() { return properties; }
}