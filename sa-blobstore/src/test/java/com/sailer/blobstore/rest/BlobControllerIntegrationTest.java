package com.sailer.blobstore.rest;

import com.sailer.blobstore.SaBlobstoreApplication;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.UUID;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Integration test for BlobController REST endpoints
 * 
 * Verifies that the REST API endpoints work correctly and are compatible
 * with the agentic-net-test-client's BlobStoreApiClient expectations.
 */
@SpringBootTest(
    classes = SaBlobstoreApplication.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT
)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
    "sa.blobstore.storage.path=./target/test-blobstore-data",
    "sa.blobstore.cluster.node-id=test-node",
    "logging.level.com.sailer.blobstore=DEBUG"
})
class BlobControllerIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void testBlobLifecycle() throws Exception {
        // Generate a valid blob ID (UUID format - must be at least 36 chars)
        String blobId = "test/" + UUID.randomUUID().toString() + "/integration-test-blob";
        String content = "Hello, SA-BLOBSTORE integration test!";
        
        // Test 1: Upload blob
        mockMvc.perform(post("/api/blobs/{blobId}", blobId)
                .contentType(MediaType.TEXT_PLAIN)
                .content(content))
                .andExpect(status().isCreated())
                .andExpect(header().exists("ETag"))
                .andExpect(jsonPath("$.blobId").value(blobId))
                .andExpect(jsonPath("$.size").value(content.length()))
                .andExpect(jsonPath("$.status").value("uploaded"));

        // Test 2: Check blob exists
        mockMvc.perform(head("/api/blobs/{blobId}", blobId))
                .andExpect(status().isOk())
                .andExpect(header().exists("X-Blob-Id"))
                .andExpect(header().string("X-Blob-Id", blobId));

        // Test 3: Download blob
        mockMvc.perform(get("/api/blobs/{blobId}", blobId))
                .andExpect(status().isOk())
                .andExpect(header().exists("ETag"))
                .andExpect(header().string("X-Blob-Id", blobId))
                .andExpect(content().contentType(MediaType.TEXT_PLAIN))
                .andExpect(content().string(content));

        // Test 4: Delete blob
        mockMvc.perform(delete("/api/blobs/{blobId}", blobId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.blobId").value(blobId))
                .andExpect(jsonPath("$.deleted").value(true))
                .andExpect(jsonPath("$.status").value("deleted"));

        // Test 5: Verify blob is deleted
        mockMvc.perform(head("/api/blobs/{blobId}", blobId))
                .andExpect(status().isNotFound());

        mockMvc.perform(get("/api/blobs/{blobId}", blobId))
                .andExpect(status().isNotFound());
    }

    @Test
    void testBlobValidation() throws Exception {
        // Test invalid blob ID (too short)
        String invalidBlobId = "too-short";
        String content = "test content";

        mockMvc.perform(post("/api/blobs/{blobId}", invalidBlobId)
                .contentType(MediaType.TEXT_PLAIN)
                .content(content))
                .andExpect(status().isBadRequest());
    }

    @Test
    void testClusterHealthEndpoints() throws Exception {
        // Test cluster health
        mockMvc.perform(get("/api/cluster/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nodeId").value("test-node"))
                .andExpect(jsonPath("$.status").value("UP"));

        // Test cluster status
        mockMvc.perform(get("/api/cluster/status"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nodeId").value("test-node"))
                .andExpect(jsonPath("$.status").value("ACTIVE"));

        // Test storage stats
        mockMvc.perform(get("/api/cluster/storage-stats"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.storagePath").exists());
    }

    @Test
    void testActuatorHealthEndpoint() throws Exception {
        // Test Spring Boot Actuator health (used by Docker health checks)
        mockMvc.perform(get("/actuator/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }
}