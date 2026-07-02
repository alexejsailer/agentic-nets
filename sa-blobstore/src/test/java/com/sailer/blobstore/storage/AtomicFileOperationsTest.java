package com.sailer.blobstore.storage;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link AtomicFileOperations} — the durability layer behind blob commits (write-to-temp then
 * atomic-move-into-place). Untested, yet a regression here means torn or lost blobs. Hermetic ({@code @TempDir}):
 * covers stream write (with parent-dir creation), atomic move (create dest dir + overwrite + source removal),
 * retry giving up cleanly on an impossible move, safe delete (single + bulk), unique temp-file creation, and the
 * never-throwing size probe.
 */
class AtomicFileOperationsTest {

    @TempDir
    Path dir;

    private AtomicFileOperations ops;

    @BeforeEach
    void setUp() {
        ops = new AtomicFileOperations();
    }

    private ByteArrayInputStream stream(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void writeToTempFileWritesBytesAndCreatesParentDir() throws Exception {
        Path target = dir.resolve("nested/staging.tmp"); // parent doesn't exist yet
        long written = ops.writeToTempFile(stream("payload"), target, 8192);

        assertEquals(7, written, "should report the exact byte count written");
        assertTrue(Files.exists(target));
        assertEquals("payload", Files.readString(target));
    }

    @Test
    void atomicMoveRelocatesContentAndRemovesSource() throws Exception {
        Path src = dir.resolve("src.tmp");
        Files.writeString(src, "blob-bytes");
        Path dest = dir.resolve("final/aa/bb/blob.blob"); // dest dirs don't exist yet

        assertTrue(ops.atomicMove(src, dest, false));
        assertFalse(Files.exists(src), "the source must be gone after an atomic move");
        assertEquals("blob-bytes", Files.readString(dest));
    }

    @Test
    void atomicMoveOverwritesExistingDestination() throws Exception {
        Path src = dir.resolve("src.tmp");
        Files.writeString(src, "new");
        Path dest = dir.resolve("dest.blob");
        Files.writeString(dest, "old");

        assertTrue(ops.atomicMove(src, dest, true));
        assertEquals("new", Files.readString(dest), "REPLACE_EXISTING must overwrite the old blob");
    }

    @Test
    void atomicMoveWithRetryGivesUpCleanlyWhenSourceMissing() {
        // A move whose source cannot exist must return false after exhausting retries, never throw.
        Path missing = dir.resolve("does-not-exist.tmp");
        Path dest = dir.resolve("dest.blob");
        assertFalse(ops.atomicMoveWithRetry(missing, dest, Duration.ofSeconds(2)));
        assertFalse(Files.exists(dest), "a failed move must not create the destination");
    }

    @Test
    void atomicMoveAsyncCompletesAndMoves() throws Exception {
        Path src = dir.resolve("src.tmp");
        Files.writeString(src, "async-bytes");
        Path dest = dir.resolve("async.blob");

        assertTrue(ops.atomicMoveAsync(src, dest, false, 5_000).get());
        assertEquals("async-bytes", Files.readString(dest));
    }

    @Test
    void safeDeleteReturnsTrueThenFalse() throws Exception {
        Path f = dir.resolve("gone.tmp");
        Files.writeString(f, "x");
        assertTrue(ops.safeDelete(f), "deleting an existing file returns true");
        assertFalse(ops.safeDelete(f), "deleting a missing file returns false, not an exception");
    }

    @Test
    void safeDeleteAllCountsOnlyFilesActuallyRemoved() throws Exception {
        Path a = dir.resolve("a.tmp");
        Path b = dir.resolve("b.tmp");
        Path missing = dir.resolve("nope.tmp");
        Files.writeString(a, "1");
        Files.writeString(b, "2");

        assertEquals(2, ops.safeDeleteAll(a, b, missing), "only the two present files count");
        assertFalse(Files.exists(a));
        assertFalse(Files.exists(b));
    }

    @Test
    void createTempFileMakesUniqueFilesInDir() {
        Path t1 = ops.createTempFile(dir.resolve("t"), "up-", ".tmp");
        Path t2 = ops.createTempFile(dir.resolve("t"), "up-", ".tmp");
        assertTrue(Files.exists(t1));
        assertTrue(Files.exists(t2));
        assertNotEquals(t1, t2, "each temp file must be unique to avoid concurrent-upload collisions");
        assertTrue(t1.getFileName().toString().startsWith("up-"));
        assertTrue(t1.getFileName().toString().endsWith(".tmp"));
    }

    @Test
    void getFileSizeReturnsSizeForPresentAndZeroForMissing() throws Exception {
        Path f = dir.resolve("sized.tmp");
        Files.write(f, "hello".getBytes(StandardCharsets.UTF_8));
        assertEquals(5, ops.getFileSize(f));
        assertEquals(0L, ops.getFileSize(dir.resolve("absent.tmp")), "a missing file probes as size 0, never throws");
    }
}
