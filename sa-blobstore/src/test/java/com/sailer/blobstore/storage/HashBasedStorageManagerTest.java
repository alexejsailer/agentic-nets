package com.sailer.blobstore.storage;

import com.sailer.blobstore.config.BlobStoreProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link HashBasedStorageManager} — the content-addressed layer that maps a blob id to a SHA-256
 * sharded filesystem path. This had no unit test, yet a regression in the path math (wrong sharding, lost
 * slash-sanitization, non-deterministic path) would scatter or orphan every blob. Hermetic: a {@code @TempDir}
 * is the storage root; assertions cover the path derivation, existence/size/delete lifecycle (incl. empty-shard
 * cleanup), temp-file naming, and age-based temp cleanup.
 */
class HashBasedStorageManagerTest {

    @TempDir
    Path storageRoot;

    private HashBasedStorageManager mgr;
    private BlobStoreProperties props;

    @BeforeEach
    void setUp() {
        props = new BlobStoreProperties();
        props.getStorage().setPath(storageRoot.toString());
        props.getHash().setDepth(2);
        props.getHash().setCharsPerLevel(2);
        props.getCleanup().setTempFileMaxAge(1000); // 1s — keeps the cleanup test fast
        mgr = new HashBasedStorageManager(props);
    }

    /** Re-derive the SHA-256 hex exactly as the manager does, so the sharding assertion is independent. */
    private static String sha256Hex(String input) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(input.getBytes());
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) {
            String h = Integer.toHexString(0xff & b);
            if (h.length() == 1) hex.append('0');
            hex.append(h);
        }
        return hex.toString();
    }

    @Test
    void constructorCreatesBaseAndTempDirectories() {
        assertTrue(Files.isDirectory(mgr.getBasePath()), "base dir must exist after construction");
        assertTrue(Files.isDirectory(mgr.getTempPath()), "temp dir must exist after construction");
    }

    @Test
    void blobPathIsDeterministicAndUnderBase() {
        Path p1 = mgr.getBlobPath("blob-123");
        Path p2 = mgr.getBlobPath("blob-123");
        assertEquals(p1, p2, "the same blob id must always map to the same path");
        assertTrue(p1.startsWith(mgr.getBasePath()), "blob path must live under the storage root");
        assertTrue(p1.getFileName().toString().endsWith(".blob"));
    }

    @Test
    void blobPathUsesSha256ShardingPrefix() throws Exception {
        String id = "some-blob-id";
        String hash = sha256Hex(id);
        Path rel = mgr.getBasePath().relativize(mgr.getBlobPath(id));

        // depth=2, charsPerLevel=2 → two dir levels of 2 hex chars each, then the file
        assertEquals(3, rel.getNameCount(), "expected <2 shard dirs>/<file>");
        assertEquals(hash.substring(0, 2), rel.getName(0).toString());
        assertEquals(hash.substring(2, 4), rel.getName(1).toString());
        assertEquals("some-blob-id.blob", rel.getName(2).toString());
    }

    @Test
    void blobIdWithSlashesIsSanitizedInFilename() {
        // Hierarchical ids must stay filesystem-safe: '/' → '_' in the file name only.
        assertEquals("a_b_c.blob", mgr.getBlobPath("a/b/c").getFileName().toString());
    }

    @Test
    void blobExistsReflectsFilePresence() throws Exception {
        String id = "present-blob";
        assertFalse(mgr.blobExists(id), "absent blob must not exist");

        Path path = mgr.getBlobPath(id);
        mgr.ensureDirectories(path);
        Files.writeString(path, "payload");
        assertTrue(mgr.blobExists(id), "after writing, the blob must be reported present");
    }

    @Test
    void getBlobSizeReturnsByteCount_andThrowsWhenMissing() throws Exception {
        String id = "sized-blob";
        Path path = mgr.getBlobPath(id);
        mgr.ensureDirectories(path);
        Files.write(path, "hello".getBytes(StandardCharsets.UTF_8));
        assertEquals(5, mgr.getBlobSize(id));

        assertThrows(StorageException.class, () -> mgr.getBlobSize("no-such-blob"));
    }

    @Test
    void deleteBlobReturnsTrueThenFalse_andCleansEmptyShardDirs() throws Exception {
        String id = "deletable-blob";
        String hash = sha256Hex(id);
        Path path = mgr.getBlobPath(id);
        mgr.ensureDirectories(path);
        Files.writeString(path, "x");

        assertTrue(mgr.deleteBlob(id), "deleting an existing blob returns true");
        assertFalse(Files.exists(path), "the blob file must be gone");
        assertFalse(Files.exists(mgr.getBasePath().resolve(hash.substring(0, 2))),
                "the now-empty shard directory should be cleaned up");
        assertFalse(mgr.deleteBlob(id), "deleting a missing blob returns false");
    }

    @Test
    void tempPathHelpersFollowNamingConvention() {
        assertEquals("upload-u1.tmp", mgr.getTempPath("u1").getFileName().toString());
        assertTrue(mgr.getTempPath("u1").startsWith(mgr.getTempPath()));
        assertEquals("blob-a_b-sess9.tmp", mgr.getTempPath("a/b", "sess9").getFileName().toString());
        assertEquals("replication-r1.tmp", mgr.getTempReplicationPath("r1").getFileName().toString());
    }

    @Test
    void cleanupOldTempFilesDeletesAgedButKeepsFresh() throws Exception {
        Path old = mgr.getTempPath("old");
        Path fresh = mgr.getTempPath("fresh");
        Files.writeString(old, "old");
        Files.writeString(fresh, "fresh");
        // Age the old file well past tempFileMaxAge (1s); leave the fresh one at "now".
        Files.setLastModifiedTime(old, FileTime.fromMillis(System.currentTimeMillis() - 60_000));

        int cleaned = mgr.cleanupOldTempFiles();

        assertEquals(1, cleaned, "only the aged temp file should be cleaned");
        assertFalse(Files.exists(old), "aged temp file must be deleted");
        assertTrue(Files.exists(fresh), "fresh temp file must survive");
    }
}
