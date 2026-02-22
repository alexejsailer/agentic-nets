package com.sailer.blobstore.config;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Tracer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenTelemetry configuration for SA-BLOBSTORE
 * 
 * Provides tracing capabilities for monitoring blob storage operations
 * and cluster health across the distributed system.
 */
@Configuration
public class OpenTelemetryConfiguration {

    /**
     * OpenTelemetry instance bean
     */
    @Bean
    public OpenTelemetry openTelemetry() {
        return GlobalOpenTelemetry.get();
    }

    /**
     * Tracer bean for SA-BLOBSTORE operations
     */
    @Bean
    public Tracer tracer(OpenTelemetry openTelemetry) {
        return openTelemetry.getTracer("sa-blobstore", "1.0.0");
    }
}