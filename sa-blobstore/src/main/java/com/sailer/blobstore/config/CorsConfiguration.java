package com.sailer.blobstore.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Read-only CORS for blob content.
 *
 * <p>Studio (and applications hosted inside it) fetch blob text straight from the browser at
 * {@code http://<host>:8090/api/blobs/<id>} — the same origin as the page but a different port,
 * which is cross-origin. Without these headers the browser drops the response and every blob
 * pointer on a token is a dead link in the UI. Only {@code GET}/{@code HEAD} are opened: reading
 * a blob by id is already unauthenticated for any HTTP client, so this exposes nothing new,
 * while writes and deletes stay same-origin only.</p>
 *
 * <p>{@code sa.blobstore.cors.allowed-origins} (comma-separated, default {@code *}) narrows the
 * origins for deployments that front the blobstore on a public host.</p>
 */
@Configuration
public class CorsConfiguration implements WebMvcConfigurer {

    private final String[] allowedOrigins;

    public CorsConfiguration(@Value("${sa.blobstore.cors.allowed-origins:*}") String allowedOrigins) {
        this.allowedOrigins = java.util.Arrays.stream(allowedOrigins.split(","))
                .map(String::trim).filter(s -> !s.isEmpty()).toArray(String[]::new);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/blobs/**")
                .allowedOrigins(allowedOrigins)
                .allowedMethods("GET", "HEAD", "OPTIONS")
                .exposedHeaders("ETag", "X-Blob-Id", "Content-Length", "Content-Type")
                .maxAge(3600);
    }
}
