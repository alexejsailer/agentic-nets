package com.sailer.agenticos.agenticnetgateway.rest;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Integration test for the gateway HealthController.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
		"gateway.master-url=http://localhost:8082",
		"otel.sdk.disabled=true"
})
class HealthControllerIntegrationTest {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void testBasicHealthEndpoint() throws Exception {
		mockMvc.perform(get("/api/health").accept(MediaType.APPLICATION_JSON))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("UP"))
				.andExpect(jsonPath("$.service").value("agentic-net-gateway"))
				.andExpect(jsonPath("$.timestamp").exists())
				.andExpect(jsonPath("$.masterUrl").value("http://localhost:8082"));
	}

	@Test
	void testPingEndpoint() throws Exception {
		mockMvc.perform(get("/api/health/ping"))
				.andExpect(status().isOk())
				.andExpect(content().string("pong"));
	}
}
