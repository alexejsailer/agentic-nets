package com.sailer.blobstore.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.util.List;

/**
 * Cluster configuration properties for SA-BLOBSTORE
 * 
 * Manages cluster topology, node discovery, and inter-node communication settings.
 */
@ConfigurationProperties(prefix = "sa.blobstore.cluster")
public record ClusterProperties(
    @DefaultValue("node1") String nodeId,
    @DefaultValue("1") int minReplicas,
    @DefaultValue("2") int maxReplicas,
    @DefaultValue({"http://localhost:8080", "http://localhost:8081", "http://localhost:8082"}) 
    List<String> nodes,
    @DefaultValue("30000") long healthCheckInterval,
    @DefaultValue("3") int maxRetries,
    @DefaultValue("1000") long retryDelay
) {}