package com.sailer.agenticos.agenticnetexecutor.transition.command;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ExecutorEnvScrubberTest {

    @Test
    void removesCrossTransitionSecretsButKeepsBenignAndProviderVars() {
        Map<String, String> env = new HashMap<>();
        env.put("AGENTICOS_CREDENTIALS_KEY", "aes-key");
        env.put("GATEWAY_INTERNAL_SECRET", "internal");
        env.put("AGENTICOS_EXECUTOR_SECRET", "exec");
        env.put("AGENTICOS_SOMETHING_SECRET", "x");
        env.put("PATH", "/usr/bin");
        env.put("HOME", "/home/agenticnet");
        env.put("ANTHROPIC_API_KEY", "provider-key-lanes-may-need");

        ExecutorEnvScrubber.scrub(env);

        assertThat(env).doesNotContainKeys(
                "AGENTICOS_CREDENTIALS_KEY",
                "GATEWAY_INTERNAL_SECRET",
                "AGENTICOS_EXECUTOR_SECRET",
                "AGENTICOS_SOMETHING_SECRET");
        // Benign and provider vars survive.
        assertThat(env).containsKeys("PATH", "HOME", "ANTHROPIC_API_KEY");
    }
}
