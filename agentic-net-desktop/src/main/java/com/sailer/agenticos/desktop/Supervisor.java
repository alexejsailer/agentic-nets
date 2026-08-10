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
 * children (bounded), and stops everything in reverse order on quit.
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
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .build();
    /** Called with (serviceName, status) on every change — drives the tray UI. */
    private volatile BiConsumer<String, Status> listener = (n, s) -> { };

    public Supervisor(List<ServiceSpec> specs, Path logsDir) {
        this.specs = specs;
        this.logsDir = logsDir;
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

        ProcessBuilder pb = new ProcessBuilder(spec.command())
            .directory(spec.workingDir().toFile())
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.appendTo(
                logsDir.resolve(spec.name() + ".console.log").toFile()));
        pb.environment().putAll(spec.env());

        Process process = pb.start();
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

    public void stopAll() {
        stopping.set(true);
        List<ServiceSpec> reversed = specs.reversed();
        for (ServiceSpec spec : reversed) {
            Process process = processes.get(spec.name());
            if (process == null || !process.isAlive()) {
                continue;
            }
            process.destroy();
        }
        for (ServiceSpec spec : reversed) {
            Process process = processes.get(spec.name());
            if (process == null) {
                continue;
            }
            try {
                if (!process.waitFor(10, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    // Wait for the kill to LAND: TerminateProcess is asynchronous and file
                    // handles are released only at actual death. The Windows updater relies
                    // on stopAll returning with no child still holding the install dir.
                    process.waitFor(5, TimeUnit.SECONDS);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
            if (!process.isAlive()) {
                PidRegistry.clear(spec.workingDir()); // clean stops leave no stale record
            }
            setStatus(spec.name(), Status.STOPPED);
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
