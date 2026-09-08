package com.sailer.agenticos.agenticnetexecutor.transition.command;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Removes cross-transition secrets from a child process's inherited environment before a
 * command/script lane runs.
 *
 * <p>{@code ProcessBuilder} starts from the executor's own environment, so without scrubbing a
 * command lane could {@code echo $AGENTICOS_CREDENTIALS_KEY} — the AES key master and executor use
 * to decrypt <em>every</em> transition's credentials — or the gateway/executor client secrets, and
 * exfiltrate them. None of those is ever needed by a lane's own command, so they are stripped.</p>
 *
 * <p>Deliberately conservative: provider API keys (for example {@code ANTHROPIC_API_KEY}) are left
 * in place, because lanes that shell out to an LLM CLI legitimately rely on them. Extra names can
 * be denied via {@code AGENTICOS_EXECUTOR_ENV_DENYLIST} (comma-separated), and token-supplied
 * {@code env} is applied AFTER scrubbing, so a lane can still set any variable it explicitly needs.</p>
 */
final class ExecutorEnvScrubber {

    private static final Logger logger = LoggerFactory.getLogger(ExecutorEnvScrubber.class);

    /** Exact variable names always removed from a child's inherited environment. */
    private static final Set<String> DENY_EXACT = Set.of(
            "AGENTICOS_CREDENTIALS_KEY",
            "GATEWAY_INTERNAL_SECRET",
            "AGENTICOS_INTERNAL_SECRET",
            "AGENTICOS_EXECUTOR_SECRET",
            "AGENTICOS_ADMIN_SECRET",
            "AGENTICOS_READONLY_SECRET");

    private static final Set<String> DENY_EXTRA = parseExtra(System.getenv("AGENTICOS_EXECUTOR_ENV_DENYLIST"));

    private ExecutorEnvScrubber() {}

    /**
     * Strip cross-transition secrets from {@code environment} (the live {@code ProcessBuilder}
     * environment map). Call before applying any token-supplied env.
     */
    static void scrub(Map<String, String> environment) {
        if (environment == null || environment.isEmpty()) {
            return;
        }
        int removed = 0;
        for (String key : new HashSet<>(environment.keySet())) {
            if (isSensitive(key)) {
                environment.remove(key);
                removed++;
            }
        }
        if (removed > 0) {
            logger.debug("Scrubbed {} sensitive variable(s) from child process environment", removed);
        }
    }

    private static boolean isSensitive(String key) {
        if (key == null) {
            return false;
        }
        String upper = key.toUpperCase(Locale.ROOT);
        if (DENY_EXACT.contains(upper) || DENY_EXTRA.contains(upper)) {
            return true;
        }
        // Any AgenticOS/gateway-owned *SECRET* is a system credential, never a lane's own input.
        return (upper.startsWith("AGENTICOS_") || upper.startsWith("GATEWAY_")) && upper.contains("SECRET");
    }

    private static Set<String> parseExtra(String csv) {
        Set<String> out = new HashSet<>();
        if (csv != null && !csv.isBlank()) {
            Arrays.stream(csv.split(","))
                    .map(s -> s.strip().toUpperCase(Locale.ROOT))
                    .filter(s -> !s.isEmpty())
                    .forEach(out::add);
        }
        return out;
    }
}
