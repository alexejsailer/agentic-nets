package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The registry is the "we definitely know our pids" half of update identification.
 * Its safety property is the start-instant check: a pid alone is a NUMBER THE OS
 * REUSES, so an entry may only be trusted when the live process started exactly
 * when the record says it did.
 */
class PidRegistryTest {

    @TempDir
    Path runRoot;

    /** This JVM stands in for a spawned service: live, and its start instant is known. */
    @Test
    void recordsAndCollectsALiveVerifiedProcess() {
        Path runDir = runRoot.resolve("master");
        PidRegistry.record(runDir, ProcessHandle.current());

        List<ProcessHandle> live = PidRegistry.collectLive(runRoot);

        assertEquals(List.of(ProcessHandle.current().pid()),
            live.stream().map(ProcessHandle::pid).toList());
    }

    /**
     * PID REUSE: same pid, wrong start instant → the record is about some EARLIER
     * process that happened to get this number. It must be ignored AND deleted —
     * trusting it would let the sweep kill an unrelated process.
     */
    @Test
    void aReusedPidIsNeverTrusted() throws IOException {
        Path runDir = runRoot.resolve("node");
        Files.createDirectories(runDir);
        long liveStart = ProcessHandle.current().info().startInstant()
            .map(java.time.Instant::toEpochMilli).orElse(0L);
        Files.writeString(runDir.resolve(PidRegistry.FILE_NAME),
            ProcessHandle.current().pid() + " " + (liveStart + 1));

        assertEquals(List.of(), PidRegistry.collectLive(runRoot));
        assertFalse(Files.exists(runDir.resolve(PidRegistry.FILE_NAME)),
            "a stale record must be deleted, not kept around to mislead the next sweep");
    }

    @Test
    void deadPidsAndGarbageFilesAreCleanedNotTrusted() throws IOException {
        Path dead = runRoot.resolve("vault");
        Files.createDirectories(dead);
        // pid 1 is init/launchd — alive, but its start instant will never match year-1970
        Files.writeString(dead.resolve(PidRegistry.FILE_NAME), "1 1000");
        Path garbage = runRoot.resolve("gateway");
        Files.createDirectories(garbage);
        Files.writeString(garbage.resolve(PidRegistry.FILE_NAME), "not a pid at all");

        assertEquals(List.of(), PidRegistry.collectLive(runRoot));
        assertFalse(Files.exists(dead.resolve(PidRegistry.FILE_NAME)));
        assertFalse(Files.exists(garbage.resolve(PidRegistry.FILE_NAME)));
    }

    @Test
    void clearRemovesTheRecord() {
        Path runDir = runRoot.resolve("executor");
        PidRegistry.record(runDir, ProcessHandle.current());
        assertTrue(Files.exists(runDir.resolve(PidRegistry.FILE_NAME)));

        PidRegistry.clear(runDir);

        assertFalse(Files.exists(runDir.resolve(PidRegistry.FILE_NAME)));
    }
}
