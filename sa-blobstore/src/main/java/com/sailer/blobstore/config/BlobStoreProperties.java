package com.sailer.blobstore.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

/**
 * Configuration properties for SA-BLOBSTORE
 * 
 * Contains all configurable aspects of the blob storage system including
 * storage paths, replication settings, timeouts, and performance tuning.
 */
@ConfigurationProperties(prefix = "sa.blobstore")
@Validated
public class BlobStoreProperties {

    @NotBlank
    private String nodeId = "node1";

    @NotNull
    private Storage storage = new Storage();
    
    @NotNull
    private Replication replication = new Replication();
    
    @NotNull
    private Hash hash = new Hash();
    
    @NotNull
    private Timeout timeout = new Timeout();
    
    @NotNull
    private Cleanup cleanup = new Cleanup();
    
    @NotNull
    private Upload upload = new Upload();
    
    private boolean defaultOverwrite = false;

    public static class Storage {
        @NotBlank
        private String path = "/app/data";
        
        private boolean forceSync = true;
        
        @Positive
        private int bufferSize = 8192;

        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }
        public boolean isForceSync() { return forceSync; }
        public void setForceSync(boolean forceSync) { this.forceSync = forceSync; }
        public int getBufferSize() { return bufferSize; }
        public void setBufferSize(int bufferSize) { this.bufferSize = bufferSize; }
    }

    public static class Replication {
        @Min(0)
        private int minReplicas = 1;
        
        @Min(0)
        private int maxReplicas = 2;

        public int getMinReplicas() { return minReplicas; }
        public void setMinReplicas(int minReplicas) { this.minReplicas = minReplicas; }
        public int getMaxReplicas() { return maxReplicas; }
        public void setMaxReplicas(int maxReplicas) { this.maxReplicas = maxReplicas; }
    }

    public static class Hash {
        @Positive
        private int depth = 3;
        
        @Positive
        private int charsPerLevel = 2;

        public int getDepth() { return depth; }
        public void setDepth(int depth) { this.depth = depth; }
        public int getCharsPerLevel() { return charsPerLevel; }
        public void setCharsPerLevel(int charsPerLevel) { this.charsPerLevel = charsPerLevel; }
    }

    public static class Timeout {
        @Positive
        private long network = 5000;
        
        @Positive
        private long fileOperation = 10000;
        
        @Positive
        private long totalOperation = 30000;

        public long getNetwork() { return network; }
        public void setNetwork(long network) { this.network = network; }
        public long getFileOperation() { return fileOperation; }
        public void setFileOperation(long fileOperation) { this.fileOperation = fileOperation; }
        public long getTotalOperation() { return totalOperation; }
        public void setTotalOperation(long totalOperation) { this.totalOperation = totalOperation; }
    }

    public static class Cleanup {
        @Positive
        private long tempFileMaxAge = 1800000; // 30 minutes
        
        @Positive
        private long scheduleInterval = 300000; // 5 minutes
        
        @Positive
        private long abandonedSessionTimeoutMs = 900000; // 15 minutes

        public long getTempFileMaxAge() { return tempFileMaxAge; }
        public void setTempFileMaxAge(long tempFileMaxAge) { this.tempFileMaxAge = tempFileMaxAge; }
        public long getScheduleInterval() { return scheduleInterval; }
        public void setScheduleInterval(long scheduleInterval) { this.scheduleInterval = scheduleInterval; }
        public long getAbandonedSessionTimeoutMs() { return abandonedSessionTimeoutMs; }
        public void setAbandonedSessionTimeoutMs(long abandonedSessionTimeoutMs) { this.abandonedSessionTimeoutMs = abandonedSessionTimeoutMs; }
    }

    public static class Upload {
        @NotBlank
        private String maxFileSize = "100MB";
        
        @Positive
        private int maxConcurrentUploads = 10;
        
        @Positive
        private long timeoutMs = 60000; // 1 minute
        
        @Positive
        private long atomicMoveTimeoutMs = 10000; // 10 seconds

        public String getMaxFileSize() { return maxFileSize; }
        public void setMaxFileSize(String maxFileSize) { this.maxFileSize = maxFileSize; }
        public int getMaxConcurrentUploads() { return maxConcurrentUploads; }
        public void setMaxConcurrentUploads(int maxConcurrentUploads) { this.maxConcurrentUploads = maxConcurrentUploads; }
        public long getTimeoutMs() { return timeoutMs; }
        public void setTimeoutMs(long timeoutMs) { this.timeoutMs = timeoutMs; }
        public long getAtomicMoveTimeoutMs() { return atomicMoveTimeoutMs; }
        public void setAtomicMoveTimeoutMs(long atomicMoveTimeoutMs) { this.atomicMoveTimeoutMs = atomicMoveTimeoutMs; }
    }

    // Getters and setters
    public String getNodeId() { return nodeId; }
    public void setNodeId(String nodeId) { this.nodeId = nodeId; }
    public Storage getStorage() { return storage; }
    public void setStorage(Storage storage) { this.storage = storage; }
    public Replication getReplication() { return replication; }
    public void setReplication(Replication replication) { this.replication = replication; }
    public Hash getHash() { return hash; }
    public void setHash(Hash hash) { this.hash = hash; }
    public Timeout getTimeout() { return timeout; }
    public void setTimeout(Timeout timeout) { this.timeout = timeout; }
    public Cleanup getCleanup() { return cleanup; }
    public void setCleanup(Cleanup cleanup) { this.cleanup = cleanup; }
    public Upload getUpload() { return upload; }
    public void setUpload(Upload upload) { this.upload = upload; }
    public boolean isDefaultOverwrite() { return defaultOverwrite; }
    public void setDefaultOverwrite(boolean defaultOverwrite) { this.defaultOverwrite = defaultOverwrite; }
}