package com.sailer.agenticos.desktop;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The quit path, on real processes: stop one at a time in order, kill what is left when the
 * grace budget runs out. POSIX only — the assertions need a shell that can ignore SIGTERM.
 */
class SupervisorShutdownTest {

    private final List<Process> spawned = new ArrayList<>();

    @BeforeEach
    void posixOnly() {
        Assumptions.assumeTrue(File.separatorChar == '/');
    }

    @AfterEach
    void killLeftovers() {
        spawned.forEach(Process::destroyForcibly);
    }

    /** Exits on SIGTERM, like every service that shuts down properly. */
    private Process wellBehaved() throws Exception {
        Process p = new ProcessBuilder("/bin/sh", "-c", "exec sleep 300").start();
        spawned.add(p);
        return p;
    }

    /**
     * Exits on SIGTERM, but takes a moment about it — a Spring Boot service closing its
     * context, not an idle sleep. Without that moment the sequencing assertion below would
     * pass against a parallel stop too, purely because the exits are instant.
     */
    private Process slowButPolite() throws Exception {
        Process p = new ProcessBuilder("/bin/sh", "-c",
            "trap 'sleep 0.5; exit 0' TERM; while :; do sleep 0.2; done").start();
        spawned.add(p);
        awaitTrapInstalled();
        return p;
    }

    /** Ignores SIGTERM entirely: only a kill ends it. */
    private Process stubborn() throws Exception {
        Process p = new ProcessBuilder("/bin/sh", "-c",
            "trap '' TERM; while :; do sleep 0.2; done").start();
        spawned.add(p);
        awaitTrapInstalled();
        return p;
    }

    /** The trap is installed a few ms after exec; signalling before that would kill it anyway. */
    private void awaitTrapInstalled() throws InterruptedException {
        Thread.sleep(300);
    }

    @Test
    void stopsOneAtATimeInOrder() throws Exception {
        List<Process> raw = List.of(slowButPolite(), slowButPolite(), slowButPolite());
        List<String> overlaps = Collections.synchronizedList(new ArrayList<>());
        List<String> stopped = Collections.synchronizedList(new ArrayList<>());

        List<Supervisor.StopTarget> targets = new ArrayList<>();
        for (int i = 0; i < raw.size(); i++) {
            int index = i;
            // Signalling target i while any earlier one is still alive is a parallel stop
            // wearing a sequential loop — the exact shape this replaced.
            Process recording = new RecordingProcess(raw.get(index), () -> {
                for (int earlier = 0; earlier < index; earlier++) {
                    if (raw.get(earlier).isAlive()) {
                        overlaps.add(index + " signalled while " + earlier + " was still alive");
                    }
                }
            });
            targets.add(new Supervisor.StopTarget("svc-" + index, recording,
                () -> stopped.add("svc-" + index)));
        }

        Supervisor.stopInOrder(targets, Duration.ofSeconds(10), Duration.ofSeconds(5));

        assertEquals(List.of(), overlaps, "services must be stopped one at a time");
        assertEquals(List.of("svc-0", "svc-1", "svc-2"), stopped, "reported in shutdown order");
        raw.forEach(p -> assertFalse(p.isAlive(), "every service is down"));
    }

    @Test
    void killsWhatIgnoresTheGracefulStop() throws Exception {
        Process stubborn = stubborn();
        Process polite = wellBehaved();
        List<String> stopped = new ArrayList<>();
        List<Supervisor.StopTarget> targets = List.of(
            new Supervisor.StopTarget("stubborn", stubborn, () -> stopped.add("stubborn")),
            new Supervisor.StopTarget("polite", polite, () -> stopped.add("polite")));

        Supervisor.stopInOrder(targets, Duration.ofSeconds(2), Duration.ofSeconds(5));

        assertFalse(stubborn.isAlive(), "a service that ignores SIGTERM still gets killed");
        assertFalse(polite.isAlive(), "and the one behind it is stopped too");
        assertEquals(List.of("stubborn", "polite"), stopped);
    }

    /**
     * The budget is the whole shutdown, not a per-service allowance: three services that
     * all ignore SIGTERM must still be gone in about the grace period, not three times it.
     */
    @Test
    void spendsTheGraceBudgetOnceAcrossAllServices() throws Exception {
        List<Process> raw = List.of(stubborn(), stubborn(), stubborn());
        List<Supervisor.StopTarget> targets = raw.stream()
            .map(p -> new Supervisor.StopTarget("stubborn", p, () -> { }))
            .toList();

        long start = System.nanoTime();
        Supervisor.stopInOrder(targets, Duration.ofSeconds(3), Duration.ofSeconds(5));
        Duration elapsed = Duration.ofNanos(System.nanoTime() - start);

        raw.forEach(p -> assertFalse(p.isAlive(), "every service is down"));
        assertTrue(elapsed.toMillis() < 6000,
            "3 stubborn services took " + elapsed.toMillis() + "ms — the budget is being spent per service");
    }

    /** Delegating process that reports each SIGTERM; nothing else about the process changes. */
    private static final class RecordingProcess extends Process {

        private final Process delegate;
        private final Runnable onDestroy;

        RecordingProcess(Process delegate, Runnable onDestroy) {
            this.delegate = delegate;
            this.onDestroy = onDestroy;
        }

        @Override
        public void destroy() {
            onDestroy.run();
            delegate.destroy();
        }

        // Process.destroyForcibly() defaults to calling destroy() — without this override a
        // kill would be a second SIGTERM, and the stubborn cases would never end.
        @Override
        public Process destroyForcibly() {
            return delegate.destroyForcibly();
        }

        @Override
        public boolean isAlive() {
            return delegate.isAlive();
        }

        @Override
        public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
            return delegate.waitFor(timeout, unit);
        }

        @Override
        public int waitFor() throws InterruptedException {
            return delegate.waitFor();
        }

        @Override
        public int exitValue() {
            return delegate.exitValue();
        }

        @Override
        public OutputStream getOutputStream() {
            return delegate.getOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return delegate.getInputStream();
        }

        @Override
        public InputStream getErrorStream() {
            return delegate.getErrorStream();
        }
    }
}
