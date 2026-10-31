package com.sailer.agenticos.desktop;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * One supervised child process. An {@code optional} one (Studio's voice) never stops the stack: when it cannot
 * start it is shown as unavailable and everything else runs on.
 */
public record ServiceSpec(
    String name,
    String displayName,
    List<String> command,
    Map<String, String> env,
    Path workingDir,
    String healthUrl,
    int startTimeoutSeconds,
    boolean optional
) {
    /** A required service: the stack does not run without it. */
    public ServiceSpec(String name, String displayName, List<String> command, Map<String, String> env,
                       Path workingDir, String healthUrl, int startTimeoutSeconds) {
        this(name, displayName, command, env, workingDir, healthUrl, startTimeoutSeconds, false);
    }
}
