package com.sailer.agenticos.agenticnetgateway.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/** The opt-in public hub opens the PUBLIC catalog only, never the package registry (it holds private packages). */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "gateway.hub.public-catalog=true",
        "gateway.master-url=http://127.0.0.1:1",
        "otel.sdk.disabled=true"
})
class PublicCatalogScopeIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void anonymousCallersReachThePublicCatalogButNotThePackageRegistry() throws Exception {
        int publicCatalog = mockMvc.perform(get("/api/hub/public/catalog")).andReturn().getResponse().getStatus();
        assertThat(publicCatalog).isNotIn(401, 403);
        assertThat(mockMvc.perform(get("/api/packages")).andReturn().getResponse().getStatus()).isEqualTo(401);
        assertThat(mockMvc.perform(get("/api/packages/private-thing/versions/1.0.0")).andReturn().getResponse().getStatus()).isEqualTo(401);
    }
}
