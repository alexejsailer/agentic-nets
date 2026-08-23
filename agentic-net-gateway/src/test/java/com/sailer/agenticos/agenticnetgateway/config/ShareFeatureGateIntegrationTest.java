package com.sailer.agenticos.agenticnetgateway.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "gateway.share-enabled=false",
        "gateway.master-url=http://localhost:8082",
        "otel.sdk.disabled=true"
})
class ShareFeatureGateIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void disabledSharingRejectsAuthenticatedLinkCreationBeforeProxying() throws Exception {
        mockMvc.perform(post("/api/shares")
                        .with(jwt().jwt(token -> token.claim("scope", "agenticos admin")))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"modelId\":\"m1\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void disabledSharingDoesNotExposeTheAnonymousExchange() throws Exception {
        mockMvc.perform(post("/oauth2/share")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"shareId\":\"secret\"}"))
                .andExpect(status().isUnauthorized());
    }
}
