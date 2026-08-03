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
     * The only executables this installation ships. A kill requires BOTH factors: the
     * path under the install root (findUnder) AND one of these image names. Anything
     * else found under the root — however it got there — is never killed; it is
     * reported as a survivor so the update aborts and names it instead.
     */
    private static final Set<String> KNOWN_IMAGE_NAMES = Set.of(
        "java", "java.exe",             // bundled runtime running the services
        "node", "node.exe",             // bundled node running the MCP server
        "AgenticNetOS", "AgenticNetOS.exe"); // the launcher itself

    static boolean isKnownImage(String commandPath) {
        Path name = Path.of(commandPath).getFileName();
        if (name == null) {
            return false;
        }
        String image = name.toString();
        return File.separatorChar == '\\'
            ? KNOWN_IMAGE_NAMES.stream().anyMatch(k -> k.equalsIgnoreCase(image))
            : KNOWN_IMAGE_NAMES.contains(image);
    }

    /**
     * Kill what is POSITIVELY OURS under {@code installRoot} — path and image name both —
     * then WAIT until the kills have landed: file handles and ports are released only at
     * actual process death, and the whole point of the sweep is that the caller may rely
     * on that afterwards. Every pid is logged with its executable before anything is sent
     * a signal. Deliberately NO descendant expansion: a descendant is tree membership,
     * not identity, and killing by anything less than positive identity is how an updater
     * kills somebody's unrelated process.
     *
     * @return the survivors — both refused kills and failed ones; empty means the install
     *         directory is provably quiet
     */
    static List<ProcessHandle> killAllUnder(Path installRoot, Path runRoot,
                                            Duration graceful, Duration afterForce) {
        // Registry first: pid + start-instant entries written at spawn are the strongest
        // identity we have, and a crashed launcher's orphans STILL have theirs — the
        // previous instance wrote them and never got to clean up. The path scan is the
        // fallback for registrations lost with a deleted run directory.
        List<ProcessHandle> registered = PidRegistry.collectLive(runRoot);
        Set<Long> verified = registered.stream().map(ProcessHandle::pid)
            .collect(Collectors.toSet());
        Set<ProcessHandle> found = new LinkedHashSet<>(registered);
        found.addAll(findUnder(installRoot));
        return sweep(List.copyOf(found), verified, graceful, afterForce);
    }

    /** Package-private so the partition-and-refuse behavior is testable on explicit handles. */
    static List<ProcessHandle> sweep(List<ProcessHandle> found, Set<Long> verifiedPids,
                                     Duration graceful, Duration afterForce) {
        Set<ProcessHandle> targets = new LinkedHashSet<>();
        List<ProcessHandle> refused = new java.util.ArrayList<>();
        for (ProcessHandle p : found) {
            String cmd = p.info().command().orElse("");
            if (verifiedPids.contains(p.pid()) || isKnownImage(cmd)) {
                System.out.println("[desktop] update sweep: killing pid " + p.pid()
                    + " (" + (cmd.isEmpty() ? "registered at spawn" : cmd) + ")");
                targets.add(p);
            } else {
                System.err.println("[desktop] update sweep: REFUSING pid " + p.pid()
                    + " (" + (cmd.isEmpty() ? "unknown image" : cmd) + ") — not one of ours by name");
                refused.add(p);
            }
        }
        List<ProcessHandle> survivors = new java.util.ArrayList<>(killAndWait(targets, graceful, afterForce));
        survivors.addAll(refused);
        return survivors;
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
     *
     * <p>Normalizes BOTH sides rather than trusting the caller to have done it. Lowercasing
     * only the candidate makes a raw-cased root silently match nothing on Windows — and a
     * sweep that finds nothing reports itself clean, so the update would proceed with our
     * own processes still holding the files it is about to overwrite. That is the failure
     * this class exists to prevent, so the method fails closed on its own.
     */
    static boolean belongsTo(String root, String commandPath) {
        String normalizedRoot = normalized(root);
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
