package com.sailer.agenticos.agenticnetgateway.service;

import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService.MasterNode;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService.NoMasterAvailableException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.*;

/**
 * Unit tests for MasterRegistryService — validates registration, model routing,
 * round-robin assignment, heartbeat TTL, and seed master behavior.
 */
class MasterRegistryServiceTest {

    private GatewayProperties props;
    private MasterRegistryService registry;

    @BeforeEach
    void setUp() {
        props = new GatewayProperties();
        props.setMasterUrl(""); // No seed master for most tests
        props.setMasterHeartbeatTtlSeconds(60);
        registry = new MasterRegistryService(props);
    }

    // ── Registration ────────────────────────────────────────────────────────

    @Test
    void registerExplicitModels_createsModelMappings() {
        registry.register("m1", "http://master1:8082", List.of("model-a", "model-b"));

        MasterNode resolved = registry.resolveMasterForModel("model-a");
        assertThat(resolved.masterId()).isEqualTo("m1");

        resolved = registry.resolveMasterForModel("model-b");
        assertThat(resolved.masterId()).isEqualTo("m1");
    }

    @Test
    void registerWildcardMaster_doesNotCreateExplicitMappings() {
        registry.register("m1", "http://master1:8082", List.of("*"));

        List<MasterNode> masters = registry.getActiveMasters();
        assertThat(masters).hasSize(1);
        assertThat(masters.get(0).models()).containsExactly("*");
    }

    @Test
    void registerMultipleMasters_eachGetsOwnModels() {
        registry.register("m1", "http://master1:8082", List.of("model-a"));
        registry.register("m2", "http://master2:8082", List.of("model-b"));

        assertThat(registry.resolveMasterForModel("model-a").masterId()).isEqualTo("m1");
        assertThat(registry.resolveMasterForModel("model-b").masterId()).isEqualTo("m2");
    }

    // ── Resolution ──────────────────────────────────────────────────────────

    @Test
    void resolveExplicitModel_returnsCorrectMaster() {
        registry.register("m1", "http://master1:8082", List.of("model-a", "model-b"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        // Explicit model should always go to m1, never round-robin
        for (int i = 0; i < 10; i++) {
            assertThat(registry.resolveMasterForModel("model-a").masterId()).isEqualTo("m1");
        }
    }

    @Test
    void resolveUnknownModel_assignsViaRoundRobin() {
        registry.register("m1", "http://master1:8082", List.of("*"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        // First unknown model gets assigned to one wildcard master
        MasterNode first = registry.resolveMasterForModel("model-x");
        assertThat(first).isNotNull();

        // Same model should consistently return the same master (cached mapping)
        MasterNode again = registry.resolveMasterForModel("model-x");
        assertThat(again.masterId()).isEqualTo(first.masterId());
    }

    @Test
    void resolveMultipleUnknownModels_distributesAcrossWildcards() {
        registry.register("m1", "http://master1:8082", List.of("*"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        // Generate enough unknown models to hit both masters
        Set<String> assignedMasters = new HashSet<>();
        for (int i = 0; i < 20; i++) {
            MasterNode node = registry.resolveMasterForModel("auto-model-" + i);
            assignedMasters.add(node.masterId());
        }

        // Both wildcard masters should have been used
        assertThat(assignedMasters).containsExactlyInAnyOrder("m1", "m2");
    }

    @Test
    void resolveWithNullModelId_returnsAnyMaster() {
        registry.register("m1", "http://master1:8082", List.of("*"));

        MasterNode node = registry.resolveMasterForModel(null);
        assertThat(node.masterId()).isEqualTo("m1");
    }

    @Test
    void resolveWithNoMasters_throwsException() {
        assertThatThrownBy(() -> registry.resolveMasterForModel("any"))
                .isInstanceOf(NoMasterAvailableException.class)
                .hasMessageContaining("No master available");
    }

    @Test
    void resolveAfterExplicitMasterDeregistered_fallsBackToWildcard() {
        registry.register("m1", "http://master1:8082", List.of("model-a"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        // Before deregister — goes to m1
        assertThat(registry.resolveMasterForModel("model-a").masterId()).isEqualTo("m1");

        // Deregister m1
        registry.deregister("m1");

        // Now should fall back to wildcard m2
        MasterNode node = registry.resolveMasterForModel("model-a");
        assertThat(node.masterId()).isEqualTo("m2");
    }

    // ── Heartbeat & Eviction ────────────────────────────────────────────────

    @Test
    void heartbeat_updatesLastHeartbeat() throws InterruptedException {
        registry.register("m1", "http://master1:8082", List.of("model-a"));

        MasterNode before = registry.getActiveMasters().get(0);
        Thread.sleep(50);
        registry.heartbeat("m1");
        MasterNode after = registry.getActiveMasters().get(0);

        assertThat(after.lastHeartbeat()).isAfter(before.lastHeartbeat());
    }

    @Test
    void evictStale_removesExpiredMasters() {
        // Use 1-second TTL for fast test
        props.setMasterHeartbeatTtlSeconds(1);
        registry = new MasterRegistryService(props);

        registry.register("m1", "http://master1:8082", List.of("model-a"));
        assertThat(registry.getActiveMasters()).hasSize(1);

        // Wait for TTL to expire
        try { Thread.sleep(1500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

        registry.evictStale();
        assertThat(registry.getActiveMasters()).isEmpty();
    }

    @Test
    void evictStale_preservesSeedMaster() {
        // Create registry with seed master
        props.setMasterUrl("http://seed:8082");
        props.setMasterHeartbeatTtlSeconds(1);
        registry = new MasterRegistryService(props);
        registry.init();

        assertThat(registry.getActiveMasters()).hasSize(1);

        // Wait for TTL to expire
        try { Thread.sleep(1500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

        registry.evictStale();

        // Seed master should survive eviction
        assertThat(registry.getActiveMasters()).hasSize(1);
        assertThat(registry.getActiveMasters().get(0).masterId()).isEqualTo("seed-master");
    }

    @Test
    void evictStale_removesModelMappingsForEvictedMaster() {
        props.setMasterHeartbeatTtlSeconds(1);
        registry = new MasterRegistryService(props);

        registry.register("m1", "http://master1:8082", List.of("model-a"));
        assertThat(registry.resolveMasterForModel("model-a").masterId()).isEqualTo("m1");

        // Add wildcard so resolution doesn't fail after eviction
        registry.register("m2", "http://master2:8082", List.of("*"));

        try { Thread.sleep(1500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

        // Refresh m2 so it survives eviction, but m1 is stale
        registry.heartbeat("m2");

        registry.evictStale();

        // model-a mapping should be gone; resolves to m2 via wildcard
        MasterNode node = registry.resolveMasterForModel("model-a");
        assertThat(node.masterId()).isEqualTo("m2");
    }

    // ── Deregistration ──────────────────────────────────────────────────────

    @Test
    void deregister_removesMasterAndModelMappings() {
        registry.register("m1", "http://master1:8082", List.of("model-a", "model-b"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        registry.deregister("m1");

        assertThat(registry.getActiveMasters()).hasSize(1);
        assertThat(registry.getActiveMasters().get(0).masterId()).isEqualTo("m2");

        // model-a/model-b mappings should be removed — falls back to wildcard
        assertThat(registry.resolveMasterForModel("model-a").masterId()).isEqualTo("m2");
    }

    @Test
    void deregister_unknownMaster_noOp() {
        registry.register("m1", "http://master1:8082", List.of("*"));
        registry.deregister("nonexistent");
        assertThat(registry.getActiveMasters()).hasSize(1);
    }

    // ── Seed Master ─────────────────────────────────────────────────────────

    @Test
    void seedMaster_autoRegisteredOnInit() {
        props.setMasterUrl("http://seed:8082");
        registry = new MasterRegistryService(props);
        registry.init();

        List<MasterNode> masters = registry.getActiveMasters();
        assertThat(masters).hasSize(1);
        assertThat(masters.get(0).masterId()).isEqualTo("seed-master");
        assertThat(masters.get(0).url()).isEqualTo("http://seed:8082");
        assertThat(masters.get(0).models()).containsExactly("*");
        assertThat(masters.get(0).seed()).isTrue();
    }

    @Test
    void seedMaster_handlesAllModels() {
        props.setMasterUrl("http://seed:8082");
        registry = new MasterRegistryService(props);
        registry.init();

        // Any model resolves to seed master
        assertThat(registry.resolveMasterForModel("anything").masterId()).isEqualTo("seed-master");
        assertThat(registry.resolveMasterForModel("model-z").masterId()).isEqualTo("seed-master");
    }

    @Test
    void seedMasterCoexistsWithExplicit() {
        props.setMasterUrl("http://seed:8082");
        registry = new MasterRegistryService(props);
        registry.init();

        // Register explicit master for model-a
        registry.register("m1", "http://master1:8082", List.of("model-a"));

        // model-a goes to m1, everything else to seed
        assertThat(registry.resolveMasterForModel("model-a").masterId()).isEqualTo("m1");
        assertThat(registry.resolveMasterForModel("model-other").masterId()).isEqualTo("seed-master");
    }

    // ── mastersForModels (fan-out) ──────────────────────────────────────────

    @Test
    void mastersForModels_withNull_returnsAll() {
        registry.register("m1", "http://master1:8082", List.of("model-a"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        List<MasterNode> result = registry.mastersForModels(null);
        assertThat(result).hasSize(2);
    }

    @Test
    void mastersForModels_withWildcard_returnsAll() {
        registry.register("m1", "http://master1:8082", List.of("model-a"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        List<MasterNode> result = registry.mastersForModels(List.of("*"));
        assertThat(result).hasSize(2);
    }

    @Test
    void mastersForModels_withSpecificModels_returnsMappedAndWildcards() {
        registry.register("m1", "http://master1:8082", List.of("model-a"));
        registry.register("m2", "http://master2:8082", List.of("model-b"));
        registry.register("m3", "http://master3:8082", List.of("*"));

        List<MasterNode> result = registry.mastersForModels(List.of("model-a"));

        Set<String> ids = new HashSet<>();
        result.forEach(m -> ids.add(m.masterId()));

        // Should include m1 (explicit) and m3 (wildcard)
        assertThat(ids).contains("m1", "m3");
        assertThat(ids).doesNotContain("m2");
    }

    @Test
    void mastersForModels_unmappedModel_returnsWildcards() {
        registry.register("m1", "http://master1:8082", List.of("model-a"));
        registry.register("m2", "http://master2:8082", List.of("*"));

        List<MasterNode> result = registry.mastersForModels(List.of("model-unknown"));

        Set<String> ids = new HashSet<>();
        result.forEach(m -> ids.add(m.masterId()));

        // Only wildcard master
        assertThat(ids).containsExactly("m2");
    }

    // ── Re-registration ─────────────────────────────────────────────────────

    @Test
    void reRegister_updatesExistingMaster() {
        registry.register("m1", "http://master1:8082", List.of("model-a"));
        registry.register("m1", "http://master1-new:8082", List.of("model-a", "model-b"));

        assertThat(registry.getActiveMasters()).hasSize(1);
        assertThat(registry.getActiveMasters().get(0).url()).isEqualTo("http://master1-new:8082");
        assertThat(registry.resolveMasterForModel("model-b").masterId()).isEqualTo("m1");
    }
}
