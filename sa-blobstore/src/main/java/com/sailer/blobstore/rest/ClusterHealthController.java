package com.sailer.blobstore.rest;

import com.sailer.blobstore.config.ClusterProperties;
import com.sailer.blobstore.storage.HashBasedStorageManager;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * REST Controller for SA-BLOBSTORE cluster health and status information
 */
@RestController
@RequestMapping("/api/cluster")
public class ClusterHealthController implements HealthIndicator {
    
    private static final Logger logger = LoggerFactory.getLogger(ClusterHealthController.class);
    
    private final ClusterProperties clusterProperties;
    private final HashBasedStorageManager storageManager;
    private final Tracer tracer;

    public ClusterHealthController(ClusterProperties clusterProperties,
                                 HashBasedStorageManager storageManager,
                                 Tracer tracer) {
        this.clusterProperties = clusterProperties;
        this.storageManager = storageManager;
        this.tracer = tracer;
    }

    /**
     * Get comprehensive cluster health information
     * GET /api/cluster/health
     */
    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> getClusterHealth() {
        
        Span span = tracer.spanBuilder("cluster.health-check")
                .setAttribute("node.id", clusterProperties.nodeId())
                .startSpan();
        
        try {
            logger.debug("Cluster health check requested");
            
            Map<String, Object> healthInfo = new HashMap<>();
            
            // Basic node information
            healthInfo.put("nodeId", clusterProperties.nodeId());
            healthInfo.put("status", "UP");
            healthInfo.put("timestamp", Instant.now());
            
            // Cluster configuration
            Map<String, Object> clusterInfo = new HashMap<>();
            clusterInfo.put("minReplicas", clusterProperties.minReplicas());
            clusterInfo.put("maxReplicas", clusterProperties.maxReplicas());
            clusterInfo.put("clusterNodes", clusterProperties.nodes());
            healthInfo.put("cluster", clusterInfo);
            
            // Storage information
            Map<String, Object> storageInfo = getStorageInfo();
            healthInfo.put("storage", storageInfo);
            
            // Performance metrics (basic)
            Map<String, Object> metrics = new HashMap<>();
            metrics.put("uptime", getUptime());
            healthInfo.put("metrics", metrics);
            
            span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);
            span.setAttribute("health.status", "UP");
            
            logger.debug("Cluster health check completed for node {}", clusterProperties.nodeId());
            
            return ResponseEntity.ok(healthInfo);
            
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR);
            logger.error("Error during cluster health check", e);
            
            Map<String, Object> errorInfo = new HashMap<>();
            errorInfo.put("nodeId", clusterProperties.nodeId());
            errorInfo.put("status", "DOWN");
            errorInfo.put("timestamp", Instant.now());
            errorInfo.put("error", e.getMessage());
            
            return ResponseEntity.status(503).body(errorInfo);
            
        } finally {
            span.end();
        }
    }

    /**
     * Get cluster status information
     * GET /api/cluster/status
     */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> getClusterStatus() {
        
        Span span = tracer.spanBuilder("cluster.status")
                .setAttribute("node.id", clusterProperties.nodeId())
                .startSpan();
        
        try {
            Map<String, Object> status = new HashMap<>();
            
            status.put("nodeId", clusterProperties.nodeId());
            status.put("role", determineNodeRole());
            status.put("status", "ACTIVE");
            status.put("timestamp", Instant.now());
            
            // Cluster membership
            status.put("clusterSize", clusterProperties.nodes().size());
            status.put("replicationConfig", Map.of(
                "minReplicas", clusterProperties.minReplicas(),
                "maxReplicas", clusterProperties.maxReplicas()
            ));
            
            span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);
            
            return ResponseEntity.ok(status);
            
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR);
            logger.error("Error getting cluster status", e);
            
            return ResponseEntity.status(500).body(Map.of(
                "error", "Failed to get cluster status",
                "message", e.getMessage()
            ));
            
        } finally {
            span.end();
        }
    }

    /**
     * Get storage statistics
     * GET /api/cluster/storage-stats
     */
    @GetMapping("/storage-stats")
    public ResponseEntity<Map<String, Object>> getStorageStats() {
        
        Span span = tracer.spanBuilder("cluster.storage-stats")
                .setAttribute("node.id", clusterProperties.nodeId())
                .startSpan();
        
        try {
            Map<String, Object> storageInfo = getStorageInfo();
            
            // Add blob count information
            Path storagePath = storageManager.getStorageRoot();
            long blobCount = countBlobsInStorage(storagePath);
            storageInfo.put("blobCount", blobCount);
            
            span.setAttribute("blob.count", blobCount);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.OK);
            
            return ResponseEntity.ok(storageInfo);
            
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR);
            logger.error("Error getting storage stats", e);
            
            return ResponseEntity.status(500).body(Map.of(
                "error", "Failed to get storage statistics",
                "message", e.getMessage()
            ));
            
        } finally {
            span.end();
        }
    }

    /**
     * Spring Boot Actuator health indicator
     */
    @Override
    public Health health() {
        try {
            Map<String, Object> storageInfo = getStorageInfo();
            
            return Health.up()
                .withDetail("nodeId", clusterProperties.nodeId())
                .withDetail("storage", storageInfo)
                .withDetail("cluster", Map.of(
                    "size", clusterProperties.nodes().size(),
                    "minReplicas", clusterProperties.minReplicas(),
                    "maxReplicas", clusterProperties.maxReplicas()
                ))
                .build();
                
        } catch (Exception e) {
            logger.error("Health check failed", e);
            return Health.down()
                .withDetail("nodeId", clusterProperties.nodeId())
                .withDetail("error", e.getMessage())
                .build();
        }
    }

    // Helper methods

    private Map<String, Object> getStorageInfo() {
        Map<String, Object> storageInfo = new HashMap<>();
        
        try {
            Path storagePath = storageManager.getStorageRoot();
            storageInfo.put("storagePath", storagePath.toString());
            storageInfo.put("storageExists", Files.exists(storagePath));
            
            if (Files.exists(storagePath)) {
                FileStore fileStore = Files.getFileStore(storagePath);
                
                long totalSpace = fileStore.getTotalSpace();
                long usableSpace = fileStore.getUsableSpace();
                long usedSpace = totalSpace - usableSpace;
                
                storageInfo.put("totalSpaceBytes", totalSpace);
                storageInfo.put("usableSpaceBytes", usableSpace);
                storageInfo.put("usedSpaceBytes", usedSpace);
                storageInfo.put("usagePercentage", 
                    totalSpace > 0 ? (double) usedSpace / totalSpace * 100.0 : 0.0);
                    
                // Human-readable sizes
                storageInfo.put("totalSpaceGB", totalSpace / (1024.0 * 1024.0 * 1024.0));
                storageInfo.put("usableSpaceGB", usableSpace / (1024.0 * 1024.0 * 1024.0));
                storageInfo.put("usedSpaceGB", usedSpace / (1024.0 * 1024.0 * 1024.0));
            }
            
        } catch (IOException e) {
            logger.warn("Failed to get storage information", e);
            storageInfo.put("error", "Failed to get storage info: " + e.getMessage());
        }
        
        return storageInfo;
    }

    private long countBlobsInStorage(Path storagePath) {
        try {
            if (!Files.exists(storagePath)) {
                return 0;
            }
            
            return Files.walk(storagePath)
                .filter(Files::isRegularFile)
                .filter(path -> !path.getFileName().toString().startsWith("."))
                .count();
                
        } catch (IOException e) {
            logger.warn("Failed to count blobs in storage", e);
            return -1;
        }
    }

    private String determineNodeRole() {
        // Simple role determination based on node ID
        // In a real implementation, this would be more sophisticated
        String nodeId = clusterProperties.nodeId();
        if ("node1".equals(nodeId)) {
            return "primary";
        } else {
            return "replica";
        }
    }

    private long getUptime() {
        // Simple uptime calculation
        // In a real implementation, you'd track application start time
        return System.currentTimeMillis();
    }
}