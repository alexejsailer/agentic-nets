package com.sailer.agenticos.agenticnetgateway;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.TestPropertySource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Basic Spring Boot application context test for the thin gateway.
 */
@SpringBootTest
@TestPropertySource(properties = {
		"gateway.master-url=http://localhost:8082",
		"otel.sdk.disabled=true"
})
class AgenticNetGatewayApplicationTests {

	@Autowired
	private ApplicationContext applicationContext;

	@Test
	void contextLoads() {
		assertThat(applicationContext).isNotNull();
	}

	@Test
	void verifyGatewayBeansArePresent() {
		assertThat(applicationContext.containsBean("gatewayProperties")).isTrue();
	}

	@Test
	void verifyControllersArePresent() {
		assertThat(applicationContext.containsBean("healthController")).isTrue();
		assertThat(applicationContext.containsBean("tokenController")).isTrue();
		assertThat(applicationContext.containsBean("jwksController")).isTrue();
	}
}
