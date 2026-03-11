package com.sailer.agenticos.agenticnetgateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * AgenticNet Gateway — Thin API Gateway
 *
 * The only internet-facing service in the AgetnticOS ecosystem.
 * Authenticates requests via Bearer tokens and relays to agentic-net-master.
 *
 * Port: 8083
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class AgenticNetGatewayApplication {

	public static void main(String[] args) {
		SpringApplication.run(AgenticNetGatewayApplication.class, args);
		System.out.println("\n\uD83C\uDF10 AgenticNet Gateway is ready on port 8083");
		System.out.println("\uD83D\uDCCA Health: http://localhost:8083/api/health\n");
	}
}
