package com.sailer.agenticos.agenticnetvault;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class AgenticNetVaultApplication {

	public static void main(String[] args) {
		SpringApplication.run(AgenticNetVaultApplication.class, args);
		System.out.println("\n\uD83D\uDD10 Agentic-Net Vault is ready on port 8085!");
		System.out.println("\uD83D\uDCCA Health: http://localhost:8085/api/health");
		System.out.println("\uD83D\uDCC8 Metrics: http://localhost:8085/actuator/prometheus");
	}
}
