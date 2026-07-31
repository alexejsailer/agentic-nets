package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
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

    private void watchExit(ServiceSpec spec, Process process) {
        process.onExit().thenAccept(p -> {
            if (stopping.get()) {
                setStatus(spec.name(), Status.STOPPED);
                return;
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
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
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
