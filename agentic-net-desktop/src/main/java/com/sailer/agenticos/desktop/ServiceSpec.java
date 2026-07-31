package com.sailer.agenticos.desktop;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** One supervised child process. */
public record ServiceSpec(
    String name,
    String displayName,
    List<String> command,
    Map<String, String> env,
    Path workingDir,
    String healthUrl,
    int startTimeoutSeconds
) {
}
