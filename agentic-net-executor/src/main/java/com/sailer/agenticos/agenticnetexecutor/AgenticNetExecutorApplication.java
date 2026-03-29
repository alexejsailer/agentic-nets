package com.sailer.agenticos.agenticnetexecutor;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * AgenticNet Executor Application
 *
 * Command-only executor for AgenticNetOS transitions.
 *
 * Key Capabilities:
 * - Polls agentic-net-master for assigned command transitions
 * - Executes command tokens locally (bash, fs, mcp, etc.)
 * - Emits/consumes tokens via master APIs
 *
 * Port: 8084 (node=8080, test-client=8081, master=8082, agent=8083)
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class AgenticNetExecutorApplication {

	public static void main(String[] args) {
		SpringApplication.run(AgenticNetExecutorApplication.class, args);
		System.out.println("\n⚡ Agentic Nets Executor is ready on port 8084!");
		System.out.println("📊 Health: http://localhost:8084/api/health");
		System.out.println("📈 Metrics: http://localhost:8084/actuator/prometheus");
	}

}
