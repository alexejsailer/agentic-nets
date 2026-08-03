package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The update sweep finds installation processes by EVIDENCE (executable under the install
 * root), not by the supervisor's memory — that is the whole point: orphans of a force-killed
 * previous launcher are exactly the processes nobody's bookkeeping knows about.
 */
class InstallProcessesTest {

    @TempDir
    Path tempDir;

    @Test
    void belongsToMatchesOnTheSeparatorBoundary() {
        String root = tempDir.toAbsolutePath().normalize().toString();
        String sep = File.separator;

        assertTrue(InstallProcesses.belongsTo(root, root + sep + "runtime" + sep + "bin" + sep + "java"));
        // a SIBLING whose name merely extends the root must not be claimed
        assertFalse(InstallProcesses.belongsTo(root, root + "-evil" + sep + "bin" + sep + "java"));
        assertFalse(InstallProcesses.belongsTo(root, sep + "usr" + sep + "bin" + sep + "java"));
        // the root itself is a directory, not a process image
        assertFalse(InstallProcesses.belongsTo(root, root));
    }

    /**
     * Find-by-evidence against a REAL process nobody registered: a child java spawned from
     * this JVM's own home, i.e. an executable under a known root — precisely the orphan
     * shape. (An executable copied into a temp root would be the purer fixture, but macOS
     * AMFI SIGKILLs relocated platform binaries, so the JVM home doubles as the root.)
     * Deliberately no killAllUnder here: this JVM's siblings — Maven itself — run from the
     * same home, and sweeping it would kill the build.
     */
    @Test
    void findsAProcessItNeverStartedByItsExecutablePath() throws IOException {
        Path javaHome = Path.of(System.getProperty("java.home"));
        Path javaBin = javaHome.resolve("bin").resolve(
            File.separatorChar == '\\' ? "java.exe" : "java");
        Assumptions.assumeTrue(Files.isExecutable(javaBin));
        Files.writeString(tempDir.resolve("Sleeper.java"),
            "public class Sleeper { public static void main(String[] a) throws Exception {"
                + " Thread.sleep(300_000); } }");

        Process orphan = new ProcessBuilder(
            javaBin.toString(), tempDir.resolve("Sleeper.java").toString()).start();
        try {
            // give single-file launch a moment to exec; poll rather than sleep blindly
            List<ProcessHandle> found = List.of();
            for (int i = 0; i < 50 && found.stream().noneMatch(p -> p.pid() == orphan.pid()); i++) {
                Thread.sleep(100);
                found = InstallProcesses.findUnder(javaHome);
            }
            assertTrue(found.stream().anyMatch(p -> p.pid() == orphan.pid()),
                "a process running from the install root must be found without any registration");
            long self = ProcessHandle.current().pid();
            assertTrue(found.stream().noneMatch(p -> p.pid() == self));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            orphan.destroyForcibly();
        }
    }

    /** killAndWait must not return while a target still lives — handles release at death. */
    @Test
    void killAndWaitOnlyReturnsCleanOnceTheTargetIsActuallyDead() throws IOException {
        Path javaHome = Path.of(System.getProperty("java.home"));
        Path javaBin = javaHome.resolve("bin").resolve(
            File.separatorChar == '\\' ? "java.exe" : "java");
        Assumptions.assumeTrue(Files.isExecutable(javaBin));
        Files.writeString(tempDir.resolve("Sleeper.java"),
            "public class Sleeper { public static void main(String[] a) throws Exception {"
                + " Thread.sleep(300_000); } }");
        Process target = new ProcessBuilder(
            javaBin.toString(), tempDir.resolve("Sleeper.java").toString()).start();
        try {
            List<ProcessHandle> survivors = InstallProcesses.killAndWait(
                List.of(target.toHandle()), Duration.ofSeconds(10), Duration.ofSeconds(5));

            assertEquals(List.of(), survivors, "clean return promises the target is dead");
            assertFalse(target.isAlive());
        } finally {
            target.destroyForcibly();
        }
    }

    @Test
    void onlyTheShippedImageNamesCountAsOurs() {
        String sep = File.separator;
        assertTrue(InstallProcesses.isKnownImage(sep + "root" + sep + "runtime" + sep + "bin" + sep + "java"));
        assertTrue(InstallProcesses.isKnownImage(sep + "root" + sep + "node-runtime" + sep + "bin" + sep + "node"));
        assertTrue(InstallProcesses.isKnownImage(sep + "root" + sep + "MacOS" + sep + "AgenticNetOS"));
        assertTrue(InstallProcesses.isKnownImage("C:\\r\\AgenticNetOS.exe".replace('\\', File.separatorChar)));

        assertFalse(InstallProcesses.isKnownImage(sep + "root" + sep + "bin" + sep + "sleep"));
        assertFalse(InstallProcesses.isKnownImage(sep + "root" + sep + "bin" + sep + "javac"));
        assertFalse(InstallProcesses.isKnownImage(""));
    }

    /**
     * A REAL live process with the wrong image name must be refused, stay alive, and come
     * back as a survivor — which makes the update abort and name it, rather than the
     * sweep killing anything it cannot positively identify as ours.
     */
    @Test
    void sweepRefusesToKillAProcessItCannotIdentifyAsOurs() throws IOException {
        Assumptions.assumeFalse(File.separatorChar == '\\', "POSIX fixture");
        Process bystander = new ProcessBuilder("/bin/sleep", "300").start();
        try {
            List<ProcessHandle> survivors = InstallProcesses.sweep(
                List.of(bystander.toHandle()), java.util.Set.of(), Duration.ofSeconds(2), Duration.ofSeconds(2));

            assertTrue(bystander.isAlive(), "an unidentified process must NOT be killed");
            assertEquals(List.of(bystander.pid()),
                survivors.stream().map(ProcessHandle::pid).toList(),
                "the refusal must surface as a survivor so the update aborts and names it");
        } finally {
            bystander.destroyForcibly();
        }
    }

    /** The current JVM must never sweep itself, whatever root it is asked about. */
    @Test
    void neverReportsItself() {
        Path javaHome = Path.of(System.getProperty("java.home"));
        List<ProcessHandle> found = InstallProcesses.findUnder(javaHome);
        long self = ProcessHandle.current().pid();
        assertTrue(found.stream().noneMatch(p -> p.pid() == self));
    }
}
