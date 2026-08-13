package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;

/**
 * Starts the child services in order with health gating, restarts crashed
 * children (bounded), and on quit stops them one at a time in reverse order —
 * killing whatever has not gone down when the grace budget runs out.
 */
public final class Supervisor {

    public enum Status { PENDING, STARTING, RUNNING, CRASHED, STOPPED, FAILED }

    private static final int MAX_RESTARTS = 3;

    private final List<ServiceSpec> specs;
    private final Map<String, Process> processes = new ConcurrentHashMap<>();
    private final Map<String, Status> statuses = new ConcurrentHashMap<>();
    private final Map<String, Integer> restarts = new ConcurrentHashMap<>();
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private final Path logsDir;
    private final long consoleLogMaxBytes;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .build();
    /** Called with (serviceName, status) on every change — drives the tray UI. */
    private volatile BiConsumer<String, Status> listener = (n, s) -> { };

    /** Per-service console log cap; with one retained generation that is 32 MB per service. */
    static final long DEFAULT_CONSOLE_LOG_MAX_BYTES = 16L * 1024 * 1024;

    public Supervisor(List<ServiceSpec> specs, Path logsDir) {
        this(specs, logsDir, DEFAULT_CONSOLE_LOG_MAX_BYTES);
    }

    public Supervisor(List<ServiceSpec> specs, Path logsDir, long consoleLogMaxBytes) {
        this.specs = specs;
        this.logsDir = logsDir;
        this.consoleLogMaxBytes = consoleLogMaxBytes;
        specs.forEach(s -> statuses.put(s.name(), Status.PENDING));
    }

    public void onStatusChange(BiConsumer<String, Status> listener) {
        this.listener = listener;
    }

    public Map<String, Status> statuses() {
        Map<String, Status> ordered = new LinkedHashMap<>();
        specs.forEach(s -> ordered.put(s.displayName(), statuses.get(s.name())));
        return ordered;
    }

    public boolean allRunning() {
        return statuses.values().stream().allMatch(s -> s == Status.RUNNING);
    }

    /** Sequential start with per-service health gate. Throws on the first failure. */
    public void startAll() throws IOException, InterruptedException {
        verifyPackaging();
        try {
            for (ServiceSpec spec : specs) {
                if (stopping.get()) {
                    return;
                }
                startOne(spec);
            }
        } catch (IOException | InterruptedException e) {
            stopAll();
            throw e;
        }
    }

    /**
     * Check every service jar exists BEFORE starting anything.
     *
     * <p>The start sequence is fail-fast with a teardown, so one missing jar anywhere in the
     * roster kills the whole stack — and the user only saw whichever service happened to be
     * next in line die with a generic "exited during startup". A 2.44.0/2.44.1 Windows package
     * shipped without sa-blobstore.jar, which sits SECOND in the roster: vault came up, blobstore
     * could not, and node/master/gateway/Studio never started at all. Naming every missing file
     * up front turns that into a one-line diagnosis.
     */
    private void verifyPackaging() throws IOException {
        List<String> missing = new ArrayList<>();
        for (ServiceSpec spec : specs) {
            List<String> command = spec.command();
            int jarFlag = command.indexOf("-jar");
            if (jarFlag < 0 || jarFlag + 1 >= command.size()) {
                continue; // not a plain java -jar service (mcp runs through node)
            }
            Path jar = Path.of(command.get(jarFlag + 1));
            if (!Files.isReadable(jar)) {
                missing.add(spec.displayName() + " → " + jar);
            }
        }
        if (!missing.isEmpty()) {
            throw new IOException("This installation is incomplete — "
                + missing.size() + " service file(s) are missing, so the stack cannot start:\n  "
                + String.join("\n  ", missing)
                + "\nReinstall AgenticNetOS, or report this with the version number.");
        }
    }

    private void startOne(ServiceSpec spec) throws IOException, InterruptedException {
        setStatus(spec.name(), Status.STARTING);
        Files.createDirectories(spec.workingDir());

        // PIPE, not appendTo: the output goes through a rotating writer so one service stuck in
        // an error loop cannot fill the disk (a master once wrote a 452 MB console log).
        ProcessBuilder pb = new ProcessBuilder(spec.command())
            .directory(spec.workingDir().toFile())
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.PIPE);
        pb.environment().putAll(spec.env());

        Process process = pb.start();
        ConsoleLog.pump(process.getInputStream(),
            new ConsoleLog(logsDir, spec.name(), consoleLogMaxBytes),
            "console-" + spec.name());
        processes.put(spec.name(), process);
        // pid + start instant next to the user's data: the update sweep's strongest
        // identification, and the one that still works for orphans of a crashed launcher
        PidRegistry.record(spec.workingDir(), process.toHandle());
        watchExit(spec, process);

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(spec.startTimeoutSeconds());
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) {
                setStatus(spec.name(), Status.FAILED);
                throw new IOException(spec.displayName() + " exited during startup (code "
                    + process.exitValue() + ") — see " + logsDir.resolve(spec.name() + ".console.log"));
            }
            if (isHealthy(spec.healthUrl())) {
                setStatus(spec.name(), Status.RUNNING);
                return;
            }
            Thread.sleep(1000);
        }
        setStatus(spec.name(), Status.FAILED);
        process.destroy();
        if (!process.waitFor(5, TimeUnit.SECONDS)) {
            process.destroyForcibly();
        }
        throw new IOException(spec.displayName() + " did not become healthy within "
            + spec.startTimeoutSeconds() + "s (" + spec.healthUrl() + ")");
    }

    private final java.util.Set<String> manualRestarts = ConcurrentHashMap.newKeySet();

    /**
     * Stops one child and starts it again from a freshly built spec (settings
     * changes live in the spec's env). Health-gated like startup.
     */
    public void restartOne(ServiceSpec freshSpec) throws IOException, InterruptedException {
        int index = -1;
        for (int i = 0; i < specs.size(); i++) {
            if (specs.get(i).name().equals(freshSpec.name())) {
                index = i;
            }
        }
        if (index < 0) {
            throw new IOException("unknown service: " + freshSpec.name());
        }
        specs.set(index, freshSpec);
        Process process = processes.get(freshSpec.name());
        if (process != null && process.isAlive()) {
            manualRestarts.add(freshSpec.name());
            process.destroy();
            if (!process.waitFor(15, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
        restarts.remove(freshSpec.name());
        startOne(freshSpec);
    }

    private void watchExit(ServiceSpec spec, Process process) {
        process.onExit().thenAccept(p -> {
            if (stopping.get()) {
                setStatus(spec.name(), Status.STOPPED);
                return;
            }
            if (manualRestarts.remove(spec.name())) {
                return; // restartOne() owns the lifecycle and status of this exit
            }
            int count = restarts.merge(spec.name(), 1, Integer::sum);
            if (count > MAX_RESTARTS) {
                setStatus(spec.name(), Status.CRASHED);
                return;
            }
            setStatus(spec.name(), Status.STARTING);
            Thread.ofVirtual().start(() -> {
                try {
                    Thread.sleep(5000L * count);
                    if (!stopping.get()) {
                        startOne(spec);
                    }
                } catch (Exception e) {
                    setStatus(spec.name(), Status.CRASHED);
                }
            });
        });
    }

    private boolean isHealthy(String url) {
        try {
            HttpResponse<Void> response = http.send(
                HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(2)).GET().build(),
                HttpResponse.BodyHandlers.discarding());
            return response.statusCode() >= 200 && response.statusCode() < 300;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * Total budget for the graceful phase of {@link #stopAll()}. Spent one service at a
     * time; whatever is still alive when it runs out is killed.
     */
    static final Duration SHUTDOWN_GRACE = Duration.ofSeconds(30);

    /**
     * How long a kill gets to LAND. TerminateProcess is asynchronous and file handles are
     * released only at actual death — the Windows updater relies on stopAll() returning
     * with no child still holding the install directory.
     */
    private static final Duration AFTER_KILL = Duration.ofSeconds(5);

    /**
     * Graceful, sequential teardown in reverse start order: mcp → executor → gateway →
     * master → node → blobstore → vault, so nothing is asked to stop while something that
     * still talks to it is running, and the data engine is the last one out.
     */
    public void stopAll() {
        stopping.set(true);
        List<StopTarget> targets = new ArrayList<>();
        for (ServiceSpec spec : specs.reversed()) {
            Process process = processes.get(spec.name());
            if (process == null) {
                continue; // never started — nothing to stop, and its status stays as it was
            }
            targets.add(new StopTarget(spec.displayName(), process, () -> {
                if (!process.isAlive()) {
                    PidRegistry.clear(spec.workingDir()); // clean stops leave no stale record
                }
                setStatus(spec.name(), Status.STOPPED);
            }));
        }
        stopInOrder(targets, SHUTDOWN_GRACE, AFTER_KILL);
    }

    /** One child to stop, plus what to record once it is down. */
    record StopTarget(String displayName, Process process, Runnable onStopped) { }

    /**
     * SIGTERM each target and WAIT for it to exit before touching the next one, then kill
     * whatever is still alive — in the same order.
     *
     * <p>One at a time, not all at once: a service asked to stop while its dependants are
     * still calling it logs errors on the way out, and master/node want an undisturbed
     * moment to flush. The wait is what makes the ordering mean anything — signalling
     * everything and then collecting exits (what this did before) is a parallel stop with
     * a sequential-looking loop.</p>
     *
     * <p>The grace budget is shared, not per service: each target may wait for at most its
     * fair share of what is LEFT, so one child that ignores SIGTERM cannot eat the whole
     * period and leave node and vault — the ones with state to flush — no window at all.
     * A quick exit hands its unused share to the services behind it.</p>
     */
    static void stopInOrder(List<StopTarget> targets, Duration grace, Duration afterKill) {
        long deadline = System.nanoTime() + grace.toNanos();
        for (int i = 0; i < targets.size(); i++) {
            StopTarget target = targets.get(i);
            if (!target.process().isAlive()) {
                continue;
            }
            System.out.println("[desktop] stopping " + target.displayName() + " …");
            long start = System.nanoTime();
            target.process().destroy();
            long share = Math.max(0, deadline - System.nanoTime()) / (targets.size() - i);
            awaitExit(target.process(), Duration.ofNanos(share));
            if (!target.process().isAlive()) {
                System.out.println("[desktop] " + target.displayName() + " stopped ("
                    + Duration.ofNanos(System.nanoTime() - start).toMillis() + " ms)");
            }
        }

        for (StopTarget target : targets) {
            if (target.process().isAlive()) {
                // Not "within 30s": a service is killed once the SEQUENCE is out of budget,
                // which — when the ones before it exited quickly — can be well before that.
                System.err.println("[desktop] " + target.displayName()
                    + " did not stop gracefully — killing it");
                target.process().destroyForcibly();
                awaitExit(target.process(), afterKill);
            }
            target.onStopped().run();
        }
    }

    /**
     * Interruption is not an error here: the flag stays set, every later wait returns at
     * once, and the caller's kill phase takes over — which is the right answer when the
     * JVM itself is going down.
     */
    private static void awaitExit(Process process, Duration timeout) {
        if (timeout.isZero() || timeout.isNegative()) {
            return;
        }
        try {
            process.waitFor(timeout.toNanos(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public void restartAll() throws IOException, InterruptedException {
        stopAll();
        stopping.set(false);
        restarts.clear();
        startAll();
    }

    private void setStatus(String name, Status status) {
        statuses.put(name, status);
        listener.accept(name, status);
    }
}
