package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

/**
 * A size-bounded {@code <service>.console.log}.
 *
 * <p>The launcher captures each child's merged stdout/stderr — the diagnostic of last resort,
 * because it holds what never reaches the service's own logger: JVM crashes, OOM kills, and
 * startup failures like {@code Unable to access jarfile}. It used to be a plain append redirect
 * with no bound: one master stuck in an error loop wrote a <b>452 MB</b> console log, and the
 * useful part (the tail) was unreadable without special tools.
 *
 * <p>Now it rotates: at {@code maxBytes} the current file becomes {@code .1} (replacing any
 * previous {@code .1}) and a fresh file opens, so a service costs at most {@code 2 × maxBytes}
 * on disk while always retaining recent history. An oversized file left by an older version is
 * rotated on open, so the next rotation reclaims it.
 */
final class ConsoleLog implements AutoCloseable {

    private final Path current;
    private final Path previous;
    private final long maxBytes;
    private OutputStream out;
    private long written;

    ConsoleLog(Path logsDir, String serviceName, long maxBytes) throws IOException {
        this.current = logsDir.resolve(serviceName + ".console.log");
        this.previous = logsDir.resolve(serviceName + ".console.log.1");
        this.maxBytes = Math.max(1024L, maxBytes);
        Files.createDirectories(logsDir);
        // An existing file at or over the cap (including a giant one from a pre-rotation
        // version) is rolled now rather than appended to.
        if (Files.exists(current) && Files.size(current) >= this.maxBytes) {
            rotate();
        }
        open();
    }

    private void open() throws IOException {
        out = Files.newOutputStream(current, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        written = Files.exists(current) ? Files.size(current) : 0;
    }

    private void rotate() throws IOException {
        if (out != null) {
            out.close();
            out = null;
        }
        Files.move(current, previous, StandardCopyOption.REPLACE_EXISTING);
    }

    synchronized void write(byte[] buffer, int length) throws IOException {
        if (written + length > maxBytes) {
            rotate();
            open();
        }
        out.write(buffer, 0, length);
        out.flush(); // a crash must not take the last lines with it
        written += length;
    }

    @Override
    public synchronized void close() {
        try {
            if (out != null) {
                out.close();
            }
        } catch (IOException ignored) {
            // closing a log must never mask the real failure
        } finally {
            out = null;
        }
    }

    /**
     * Drain {@code source} into this log until EOF, then close. Runs on a daemon thread so a
     * stuck child can never hold up launcher shutdown.
     */
    static Thread pump(InputStream source, ConsoleLog log, String threadName) {
        Thread thread = new Thread(() -> {
            byte[] buffer = new byte[8192];
            try (InputStream in = source; ConsoleLog sink = log) {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    sink.write(buffer, read);
                }
            } catch (IOException ignored) {
                // stream closed with the process — nothing left to record
            }
        }, threadName);
        thread.setDaemon(true);
        thread.start();
        return thread;
    }
}
