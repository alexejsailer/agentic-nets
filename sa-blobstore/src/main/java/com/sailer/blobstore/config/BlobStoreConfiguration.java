package com.sailer.blobstore.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * Main configuration class for SA-BLOBSTORE
 * 
 * Enables all configuration properties and sets up the Spring Boot
 * configuration for the blob storage system.
 */
@Configuration
@EnableConfigurationProperties({
    BlobStoreProperties.class,
    ClusterProperties.class
})
public class BlobStoreConfiguration {
    
    // Configuration properties are automatically registered as beans
    // when @EnableConfigurationProperties is used
}