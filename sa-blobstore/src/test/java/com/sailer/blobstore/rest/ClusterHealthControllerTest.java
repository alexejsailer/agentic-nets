package com.sailer.blobstore.rest;

import com.sailer.blobstore.config.BlobStoreProperties;
import com.sailer.blobstore.config.ClusterProperties;
import com.sailer.blobstore.storage.HashBasedStorageManager;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Tracer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.http.ResponseEntity;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Tests for {@link ClusterHealthController} — the REST/actuator surface that reports node identity, cluster
 * topology, filesystem capacity, and blob counts. It had no unit test, yet it carries real branching: node-role
 * derivation, on-disk space math, hidden-file-excluding blob counting, and three distinct exception → HTTP-status
 * (200/503/500) and actuator UP/DOWN degradation paths.
 *
 * <p>Hermetic: the OpenTelemetry {@link Tracer} is the API's no-op tracer (real object, zero I/O), the
 * {@link HashBasedStorageManager} is a genuine instance rooted at a {@link TempDir}, and the failure branches
 * use a Mockito mock whose {@code getStorageRoot()} throws so the controller's catch blocks are exercised.
 */
class ClusterHealthControllerTest {

    @TempDir
    Path tmp;

    private static final Tracer NOOP_TRACER = OpenTelemetry.noop().getTracer("test");

    /** Build a controller backed by a real storage manager rooted at {@code root} with the given node id. */
    private ClusterHealthController controllerWithRealStorage(String nodeId, Path root, List<String> nodes) {
        BlobStoreProperties props = new BlobStoreProperties();
        props.getStorage().setPath(root.toString());
        HashBasedStorageManager storage = new HashBasedStorageManager(props); // creates root + temp/
        ClusterProperties cluster = new ClusterProperties(nodeId, 1, 2, nodes, 30000L, 3, 1000L);
        return new ClusterHealthController(cluster, storage, NOOP_TRACER);
    }

    private static void deleteRecursively(Path dir) throws Exception {
        if (!Files.exists(dir)) return;
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        }
    }

    // ---------- /health (getClusterHealth) ----------

    @Test
    @SuppressWarnings("unchecked")
    void clusterHealthReturns200WithNodeClusterStorageAndMetrics() {
        Path root = tmp.resolve("store-health");
        ClusterHealthController c = controllerWithRealStorage("node1", root, List.of("a", "b", "c"));

        ResponseEntity<Map<String, Object>> resp = c.getClusterHealth();

        assertEquals(200, resp.getStatusCode().value());
        Map<String, Object> body = resp.getBody();
        assertNotNull(body);
        assertEquals("node1", body.get("nodeId"));
        assertEquals("UP", body.get("status"));
        assertNotNull(body.get("timestamp"));

        Map<String, Object> cluster = (Map<String, Object>) body.get("cluster");
        assertEquals(1, cluster.get("minReplicas"));
        assertEquals(2, cluster.get("maxReplicas"));
        assertEquals(List.of("a", "b", "c"), cluster.get("clusterNodes"));

        Map<String, Object> storage = (Map<String, Object>) body.get("storage");
        assertEquals(root.toString(), storage.get("storagePath"));
        assertEquals(Boolean.TRUE, storage.get("storageExists"));

        Map<String, Object> metrics = (Map<String, Object>) body.get("metrics");
        assertInstanceOf(Long.class, metrics.get("uptime"), "uptime is a millis long");
    }

    @Test
    @SuppressWarnings("unchecked")
    void clusterHealthStorageInfoExposesCapacityMath() {
        Path root = tmp.resolve("store-cap");
        ClusterHealthController c = controllerWithRealStorage("node1", root, List.of("only"));

        Map<String, Object> body = c.getClusterHealth().getBody();
        assertNotNull(body);
        Map<String, Object> storage = (Map<String, Object>) body.get("storage");

        long total = ((Number) storage.get("totalSpaceBytes")).longValue();
        long usable = ((Number) storage.get("usableSpaceBytes")).longValue();
        long used = ((Number) storage.get("usedSpaceBytes")).longValue();
        double pct = ((Number) storage.get("usagePercentage")).doubleValue();

        assertTrue(total > 0, "a real temp filesystem reports a positive total");
        assertEquals(total - usable, used, "usedSpace == total - usable");
        assertTrue(pct >= 0.0 && pct <= 100.0, "usage percentage stays in [0,100], was " + pct);
        // Human-readable GB view is the byte value / 2^30.
        assertEquals(total / (1024.0 * 1024.0 * 1024.0), (Double) storage.get("totalSpaceGB"), 1e-9);
    }

    @Test
    void clusterHealthReturns503WhenStorageManagerThrows() {
        HashBasedStorageManager broken = mock(HashBasedStorageManager.class);
        when(broken.getStorageRoot()).thenThrow(new RuntimeException("disk gone"));
        ClusterProperties cluster = new ClusterProperties("node1", 1, 2, List.of("a"), 30000L, 3, 1000L);
        ClusterHealthController c = new ClusterHealthController(cluster, broken, NOOP_TRACER);

        ResponseEntity<Map<String, Object>> resp = c.getClusterHealth();

        assertEquals(503, resp.getStatusCode().value());
        Map<String, Object> body = resp.getBody();
        assertNotNull(body);
        assertEquals("node1", body.get("nodeId"));
        assertEquals("DOWN", body.get("status"));
        assertEquals("disk gone", body.get("error"));
    }

    // ---------- /status (getClusterStatus + determineNodeRole) ----------

    @Test
    @SuppressWarnings("unchecked")
    void clusterStatusReportsPrimaryRoleForNode1() {
        Path root = tmp.resolve("store-status1");
        ClusterHealthController c = controllerWithRealStorage("node1", root, List.of("a", "b", "c"));

        ResponseEntity<Map<String, Object>> resp = c.getClusterStatus();

        assertEquals(200, resp.getStatusCode().value());
        Map<String, Object> body = resp.getBody();
        assertNotNull(body);
        assertEquals("node1", body.get("nodeId"));
        assertEquals("primary", body.get("role"));
        assertEquals("ACTIVE", body.get("status"));
        assertEquals(3, body.get("clusterSize"));

        Map<String, Object> repl = (Map<String, Object>) body.get("replicationConfig");
        assertEquals(1, repl.get("minReplicas"));
        assertEquals(2, repl.get("maxReplicas"));
    }

    @Test
    void clusterStatusReportsReplicaRoleForNonNode1() {
        Path root = tmp.resolve("store-status2");
        ClusterHealthController c = controllerWithRealStorage("node2", root, List.of("a", "b"));

        Map<String, Object> body = c.getClusterStatus().getBody();
        assertNotNull(body);
        assertEquals("replica", body.get("role"));
        assertEquals(2, body.get("clusterSize"));
    }

    // ---------- /storage-stats (getStorageStats + countBlobsInStorage) ----------

    @Test
    void storageStatsCountsRegularBlobsExcludingHiddenFiles() throws Exception {
        Path root = tmp.resolve("store-stats");
        ClusterHealthController c = controllerWithRealStorage("node1", root, List.of("a"));

        // Two real blobs in a sharded subtree, plus a hidden file that must NOT be counted.
        Path shard = root.resolve("aa").resolve("bb");
        Files.createDirectories(shard);
        Files.writeString(shard.resolve("blob1.blob"), "one");
        Files.writeString(shard.resolve("blob2.blob"), "two");
        Files.writeString(root.resolve(".hidden"), "ignore me");

        Map<String, Object> body = c.getStorageStats().getBody();
        assertNotNull(body);
        assertEquals(2L, ((Number) body.get("blobCount")).longValue(),
                "only the two .blob files count; the dot-file is excluded");
        assertEquals(Boolean.TRUE, body.get("storageExists"));
    }

    @Test
    void storageStatsReportsZeroBlobsAndAbsentStorageWhenRootMissing() throws Exception {
        Path root = tmp.resolve("store-missing");
        ClusterHealthController c = controllerWithRealStorage("node1", root, List.of("a"));
        deleteRecursively(root); // remove the root the manager created

        Map<String, Object> body = c.getStorageStats().getBody();
        assertNotNull(body);
        assertEquals(Boolean.FALSE, body.get("storageExists"));
        assertEquals(0L, ((Number) body.get("blobCount")).longValue());
    }

    @Test
    void storageStatsReturns500WhenStorageManagerThrows() {
        HashBasedStorageManager broken = mock(HashBasedStorageManager.class);
        when(broken.getStorageRoot()).thenThrow(new RuntimeException("io boom"));
        ClusterProperties cluster = new ClusterProperties("node1", 1, 2, List.of("a"), 30000L, 3, 1000L);
        ClusterHealthController c = new ClusterHealthController(cluster, broken, NOOP_TRACER);

        ResponseEntity<Map<String, Object>> resp = c.getStorageStats();

        assertEquals(500, resp.getStatusCode().value());
        Map<String, Object> body = resp.getBody();
        assertNotNull(body);
        assertEquals("io boom", body.get("message"));
    }

    // ---------- actuator health() ----------

    @Test
    @SuppressWarnings("unchecked")
    void actuatorHealthReturnsUpWithClusterAndStorageDetails() {
        Path root = tmp.resolve("store-actuator-up");
        ClusterHealthController c = controllerWithRealStorage("node1", root, List.of("a", "b"));

        Health health = c.health();

        assertEquals(Status.UP, health.getStatus());
        Map<String, Object> details = health.getDetails();
        assertEquals("node1", details.get("nodeId"));
        Map<String, Object> cluster = (Map<String, Object>) details.get("cluster");
        assertEquals(2, cluster.get("size"));
        assertEquals(1, cluster.get("minReplicas"));
        assertEquals(2, cluster.get("maxReplicas"));
        assertNotNull(details.get("storage"));
    }

    @Test
    void actuatorHealthReturnsDownWhenStorageManagerThrows() {
        HashBasedStorageManager broken = mock(HashBasedStorageManager.class);
        when(broken.getStorageRoot()).thenThrow(new RuntimeException("mount lost"));
        ClusterProperties cluster = new ClusterProperties("node1", 1, 2, List.of("a"), 30000L, 3, 1000L);
        ClusterHealthController c = new ClusterHealthController(cluster, broken, NOOP_TRACER);

        Health health = c.health();

        assertEquals(Status.DOWN, health.getStatus());
        assertEquals("node1", health.getDetails().get("nodeId"));
        assertEquals("mount lost", health.getDetails().get("error"));
    }
}
