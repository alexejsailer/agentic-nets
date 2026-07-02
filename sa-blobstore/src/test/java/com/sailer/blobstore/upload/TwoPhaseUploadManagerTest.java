package com.sailer.blobstore.upload;

import com.sailer.blobstore.config.BlobStoreProperties;
import com.sailer.blobstore.storage.AtomicFileOperations;
import com.sailer.blobstore.storage.HashBasedStorageManager;
import com.sailer.blobstore.validation.BlobIdValidator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * End-to-end tests for {@link TwoPhaseUploadManager} — the write-to-temp → verify → atomic-move pipeline that is
 * the blob store's durability guarantee. Wires the REAL storage components (no mocks) against a {@code @TempDir}
 * so the whole flow is exercised: a successful upload lands the bytes at the content-addressed path with the
 * correct SHA-256 and size, a declared content-length is enforced (mismatches fail and leave NO partial blob),
 * temp files are always cleaned up, and re-uploading the same id overwrites. Previously untested.
 */
class TwoPhaseUploadManagerTest {

    @TempDir
    Path storageRoot;

    private HashBasedStorageManager storage;
    private TwoPhaseUploadManager manager;

    @BeforeEach
    void setUp() {
        BlobStoreProperties props = new BlobStoreProperties();
        props.getStorage().setPath(storageRoot.toString());
        props.getHash().setDepth(2);
        props.getHash().setCharsPerLevel(2);
        storage = new HashBasedStorageManager(props);
        manager = new TwoPhaseUploadManager(props, new BlobIdValidator(), storage, new AtomicFileOperations());
    }

    private static ByteArrayInputStream stream(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256Hex(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private TwoPhaseUploadManager.UploadResult upload(String id, String content, long declaredLen) throws Exception {
        return manager.uploadBlob(id, stream(content), declaredLen).get(5, TimeUnit.SECONDS);
    }

    @Test
    void successfulUploadLandsBytesWithCorrectHashAndSize() throws Exception {
        String id = "uploads/tests/integration/hello-world-content-blob.txt";
        TwoPhaseUploadManager.UploadResult r = upload(id, "hello world", 11);

        assertTrue(r.success());
        assertEquals(11, r.size());
        assertEquals(sha256Hex("hello world"), r.contentHash());
        assertTrue(Files.exists(r.finalPath()), "the blob must exist at its final content-addressed path");
        assertEquals("hello world", Files.readString(r.finalPath()));
        assertTrue(storage.blobExists(id), "the storage manager must find the committed blob by id");
        assertEquals(storage.getBlobPath(id), r.finalPath());
    }

    @Test
    void unknownContentLengthIsAcceptedAndSizedFromTheStream() throws Exception {
        // contentLength 0 = "unknown" → the length check is skipped and the actual byte count is reported.
        TwoPhaseUploadManager.UploadResult r = upload("uploads/tests/integration/streamed-unknown-length-blob.bin", "abcdef", 0);
        assertTrue(r.success());
        assertEquals(6, r.size());
    }

    @Test
    void declaredContentLengthMismatchFailsAndLeavesNoBlob() {
        String id = "uploads/tests/integration/content-length-mismatch-blob.bin";
        ExecutionException ex = assertThrows(ExecutionException.class,
                () -> manager.uploadBlob(id, stream("hello"), 999).get(5, TimeUnit.SECONDS));

        assertInstanceOf(TwoPhaseUploadManager.UploadException.class, ex.getCause());
        assertTrue(ex.getCause().getMessage().contains("Content length mismatch"), ex.getCause().getMessage());
        assertFalse(storage.blobExists(id), "a failed upload must not leave a partial/committed blob behind");
    }

    @Test
    void temporaryFilesAreCleanedUpAfterASuccessfulUpload() throws Exception {
        upload("uploads/tests/integration/temp-cleanup-verification-blob.dat", "some payload bytes", 18);

        // Cleanup removes the staging file and prunes the now-empty temp dir — so either the temp root is gone
        // entirely, or it still exists but holds no leftover .tmp files. Both mean "nothing was left behind".
        Path tempRoot = storage.getTempPath();
        if (Files.exists(tempRoot)) {
            try (var walk = Files.walk(tempRoot)) {
                long tempFiles = walk.filter(Files::isRegularFile).count();
                assertEquals(0, tempFiles, "no staging .tmp files should remain after a successful upload");
            }
        }
    }

    @Test
    void reuploadingTheSameIdOverwritesTheBlob() throws Exception {
        String id = "uploads/tests/integration/overwrite-target-blob-value.txt";
        upload(id, "first-version", 13);
        TwoPhaseUploadManager.UploadResult second = upload(id, "second", 6);

        assertTrue(second.success());
        assertEquals("second", Files.readString(second.finalPath()));
        assertEquals(sha256Hex("second"), second.contentHash());
    }
}
