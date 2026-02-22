package com.sailer.blobstore;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

import com.sailer.blobstore.config.BlobStoreProperties;
import com.sailer.blobstore.config.ClusterProperties;

/**
 * SA-BLOBSTORE: Distributed Blob Storage System
 * 
 * A 3-node cluster blob storage system with configurable replication,
 * atomic two-phase uploads, immediate deletion, and S3-compatible IDs.
 * 
 * Key Features:
 * - Hash-based file organization for scalability
 * - Two-phase atomic upload process with guaranteed consistency  
 * - Immediate deletion with natural download failure
 * - S3-compatible blob IDs for future backend flexibility
 * - OpenTelemetry observability integration
 */
@SpringBootApplication
@EnableConfigurationProperties({BlobStoreProperties.class, ClusterProperties.class})
@EnableAsync
@EnableScheduling
public class SaBlobstoreApplication {

    public static void main(String[] args) {
        SpringApplication.run(SaBlobstoreApplication.class, args);
    }
}