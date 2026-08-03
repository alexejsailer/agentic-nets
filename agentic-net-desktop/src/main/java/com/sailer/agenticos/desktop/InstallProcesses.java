package com.sailer.agenticos.desktop;

import java.io.File;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Every process that belongs to this installation — whether or not THIS launcher started it.
 *
 * <p>The supervisor only knows its own children. A force-killed previous launcher (Task
 * Manager, Windows Restart Manager, a crash) never runs its shutdown hook, so its children
 * survive as orphans: still bound to the loopback ports and, on Windows, still holding file
 * handles inside the install directory — which is exactly what broke a 2.40.0 update into a
 * rollback that removed the installation. Discovery is therefore by EVIDENCE, not memory:
 * a process is ours iff its executable lives under the install root. That test covers the
 * bundled runtime's java, the bundled node, any second launcher instance, and orphans alike.</p>
 */
final class InstallProcesses {

    private InstallProcesses() {
    }

    /** Processes (excluding this one) whose executable lives under {@code installRoot}. */
    static List<ProcessHandle> findUnder(Path installRoot) {
        // toRealPath, not normalize: the OS reports each process's command as a RESOLVED
        // path, so a symlink anywhere in the root (macOS /var → /private/var, a linked
        // /opt install) would silently match nothing and the sweep would lie about being clean.
        Path resolved;
        try {
            resolved = installRoot.toRealPath();
        } catch (java.io.IOException e) {
            resolved = installRoot.toAbsolutePath().normalize();
        }
        String root = normalized(resolved.toString());
        long self = ProcessHandle.current().pid();
        return ProcessHandle.allProcesses()
            .filter(p -> p.pid() != self)
            .filter(p -> p.info().command().map(cmd -> belongsTo(root, cmd)).orElse(false))
            .collect(Collectors.toList());
    }

    /**
     * Kill everything under {@code installRoot} (and the descendants of each hit — an
     * executor's live command-lane children must not linger headless), then WAIT until the
     * kills have landed: file handles and ports are released only at actual process death,
     * and the whole point of the sweep is that the caller may rely on that afterwards.
     *
     * @return the survivors — empty means the install directory is provably quiet
     */
    static List<ProcessHandle> killAllUnder(Path installRoot, Duration graceful, Duration afterForce) {
        List<ProcessHandle> found = findUnder(installRoot);
        Set<ProcessHandle> targets = new LinkedHashSet<>(found);
        for (ProcessHandle p : found) {
            p.descendants().forEach(targets::add);
        }
        return killAndWait(targets, graceful, afterForce);
    }

    /**
     * destroy → wait → destroyForcibly the stubborn → wait again. Returns the survivors;
     * empty means every target is provably dead, which is what releases its ports and
     * (on Windows) its file handles.
     */
    static List<ProcessHandle> killAndWait(Collection<ProcessHandle> targets,
                                           Duration graceful, Duration afterForce) {
        targets.forEach(ProcessHandle::destroy);
        awaitExit(targets, graceful);
        List<ProcessHandle> stubborn = targets.stream().filter(ProcessHandle::isAlive).toList();
        stubborn.forEach(ProcessHandle::destroyForcibly);
        awaitExit(stubborn, afterForce);
        return targets.stream().filter(ProcessHandle::isAlive).toList();
    }

    /**
     * Prefix match on the SEPARATOR boundary — without it, an install at {@code C:\A} would
     * also claim processes from {@code C:\ABC}. Case-insensitive on Windows, whose
     * filesystems are.
     */
    static boolean belongsTo(String normalizedRoot, String commandPath) {
        String boundary = normalizedRoot.endsWith(File.separator)
            ? normalizedRoot
            : normalizedRoot + File.separator;
        return normalized(commandPath).startsWith(boundary);
    }

    private static String normalized(String path) {
        return File.separatorChar == '\\' ? path.toLowerCase(Locale.ROOT) : path;
    }

    private static void awaitExit(Collection<ProcessHandle> procs, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        for (ProcessHandle p : procs) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) {
                return; // out of budget — the caller re-checks isAlive and reports survivors
            }
            try {
                p.onExit().get(remaining, TimeUnit.NANOSECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception ignored) {
                // timed out or already gone — either way, isAlive() is the arbiter
            }
        }
    }
}
