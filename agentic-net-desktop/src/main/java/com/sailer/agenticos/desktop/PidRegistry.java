package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * "We should definitely know the process ids of our apps": every child the supervisor
 * spawns is recorded as {@code run/<service>/pid} next to the user's data, holding
 * {@code "<pid> <startEpochMillis>"}.
 *
 * <p>A pid alone is NOT identity — operating systems reuse them, so after a crash and a
 * reboot the recorded number may belong to anything. An entry therefore only counts when
 * the LIVE process's start instant equals what was recorded at spawn time; anything else
 * is stale and gets deleted on sight. Entries that verify are the strongest identification
 * the update sweep has — stronger than the path+name scan, which exists as the fallback
 * for registrations lost to a deleted run directory.</p>
 */
final class PidRegistry {

    static final String FILE_NAME = "pid";

    private PidRegistry() {
    }

    /** Record a just-spawned child. Failure is logged, never fatal — the path scan remains. */
    static void record(Path runDir, ProcessHandle handle) {
        try {
            Files.createDirectories(runDir);
            long start = handle.info().startInstant().map(Instant::toEpochMilli).orElse(-1L);
            Files.writeString(runDir.resolve(FILE_NAME), handle.pid() + " " + start);
        } catch (IOException e) {
            System.err.println("[desktop] could not write pidfile in " + runDir + ": " + e.getMessage());
        }
    }

    /** Remove the record after a confirmed stop, so clean shutdowns leave nothing stale. */
    static void clear(Path runDir) {
        try {
            Files.deleteIfExists(runDir.resolve(FILE_NAME));
        } catch (IOException ignored) {
            // a leftover file is harmless: collectLive verifies before trusting it
        }
    }

    /**
     * Every recorded process that is alive AND start-time-verified. Stale entries — dead
     * pid, reused pid (start instant differs), unreadable file — are deleted, never trusted.
     */
    static List<ProcessHandle> collectLive(Path runRoot) {
        List<ProcessHandle> live = new ArrayList<>();
        if (!Files.isDirectory(runRoot)) {
            return live;
        }
        try (var dirs = Files.list(runRoot)) {
            for (Path dir : dirs.toList()) {
                Path file = dir.resolve(FILE_NAME);
                if (!Files.isRegularFile(file)) {
                    continue;
                }
                try {
                    String[] parts = Files.readString(file).trim().split("\\s+");
                    long pid = Long.parseLong(parts[0]);
                    long start = parts.length > 1 ? Long.parseLong(parts[1]) : -1L;
                    Optional<ProcessHandle> handle = ProcessHandle.of(pid);
                    boolean verified = start > 0
                        && handle.map(h -> h.isAlive() && h.info().startInstant()
                            .map(i -> i.toEpochMilli() == start).orElse(false))
                        .orElse(false);
                    if (verified) {
                        live.add(handle.get());
                    } else {
                        Files.deleteIfExists(file);
                    }
                } catch (RuntimeException | IOException e) {
                    try {
                        Files.deleteIfExists(file);
                    } catch (IOException ignored) {
                        // unreadable AND undeletable — collectLive simply never trusts it
                    }
                }
            }
        } catch (IOException ignored) {
            // listing failed — fall back to the path+name scan alone
        }
        return live;
    }
}
