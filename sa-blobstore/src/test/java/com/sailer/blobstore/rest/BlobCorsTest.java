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

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * A browser page served from another port (Studio on 4200) must be able to READ a blob; it must
 * not gain write access through CORS.
 */
@SpringBootTest(classes = SaBlobstoreApplication.class,
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "sa.blobstore.storage.path=./target/test-blobstore-cors",
        "sa.blobstore.cluster.node-id=test-node"
})
class BlobCorsTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void readIsAllowedCrossOrigin() throws Exception {
        String blobId = "cors/" + UUID.randomUUID() + "/article";
        mockMvc.perform(post("/api/blobs/{id}", blobId)
                        .contentType(MediaType.TEXT_PLAIN).content("hello from a blob"))
                .andExpect(status().isCreated());

        mockMvc.perform(get("/api/blobs/{id}", blobId).header("Origin", "http://localhost:4200"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", "*"))
                .andExpect(header().string("Access-Control-Expose-Headers",
                        org.hamcrest.Matchers.containsString("ETag")));

        mockMvc.perform(options("/api/blobs/{id}", blobId)
                        .header("Origin", "http://localhost:4200")
                        .header("Access-Control-Request-Method", "GET"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Methods",
                        org.hamcrest.Matchers.containsString("GET")));
    }

    @Test
    void writeIsNotOpenedCrossOrigin() throws Exception {
        mockMvc.perform(options("/api/blobs/{id}", "cors/" + UUID.randomUUID() + "/x")
                        .header("Origin", "http://evil.example")
                        .header("Access-Control-Request-Method", "DELETE"))
                .andExpect(status().isForbidden());
    }
}
