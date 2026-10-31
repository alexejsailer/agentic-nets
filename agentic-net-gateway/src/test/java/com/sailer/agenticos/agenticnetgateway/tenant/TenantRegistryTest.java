package com.sailer.agenticos.agenticnetgateway.tenant;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TenantRegistryTest {

    @TempDir
    Path dir;

    @Test
    void aCreatedTenantSignsInWithItsKeyAndSurvivesARestart() throws Exception {
        Path file = dir.resolve("tenants.json");
        TenantRegistry r = new TenantRegistry(file, 5, 300);
        TenantRegistry.Issued issued = r.create("alice", "operator", null, null);
        assertThat(r.authenticate(issued.key())).isPresent();
        assertThat(Files.readString(file)).contains("alice").doesNotContain(issued.key());

        TenantRegistry reloaded = new TenantRegistry(file, 5, 300);
        assertThat(reloaded.authenticate(issued.key())).map(TenantRegistry.Tenant::id).contains("alice");
        assertThat(reloaded.get("alice").orElseThrow().modelsMax()).isEqualTo(5);
    }

    @Test
    void rotationAndDisablingRevokeAtOnce() {
        TenantRegistry r = new TenantRegistry(dir.resolve("t.json"), 5, 300);
        TenantRegistry.Issued first = r.create("alice", "operator", 3, 100);
        assertThat(r.stillValid("alice", 1, null)).isTrue();
        TenantRegistry.Issued second = r.rotate("alice");
        assertThat(r.authenticate(first.key())).isEmpty();
        assertThat(r.authenticate(second.key())).isPresent();
        assertThat(r.stillValid("alice", 1, null)).isFalse();
        assertThat(r.stillValid("alice", 2, null)).isTrue();
        r.setDisabled("alice", true);
        assertThat(r.authenticate(second.key())).isEmpty();
        assertThat(r.stillValid("alice", 2, null)).isFalse();
    }

    @Test
    void executorsHaveTheirOwnKeysAndDieWhenRemoved() {
        TenantRegistry r = new TenantRegistry(dir.resolve("t.json"), 5, 300);
        r.create("alice", "operator", null, null);
        TenantRegistry.Issued exec = r.addExecutor("alice", "laptop");
        assertThat(r.authenticateExecutor(exec.key())).map(e -> e.getValue().name()).contains("laptop");
        assertThat(r.authenticate(exec.key())).isEmpty();
        assertThat(r.stillValid("alice", null, "laptop")).isTrue();
        r.removeExecutor("alice", "laptop");
        assertThat(r.authenticateExecutor(exec.key())).isEmpty();
        assertThat(r.stillValid("alice", null, "laptop")).isFalse();
    }

    @Test
    void badOrDuplicateIdsAreRefused() {
        TenantRegistry r = new TenantRegistry(dir.resolve("t.json"), 5, 300);
        r.create("alice", "operator", null, null);
        assertThatThrownBy(() -> r.create("alice", "operator", null, null)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> r.create("default", "operator", null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> r.create("Bob!", "operator", null, null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void anUnreadableRegistryAdmitsNobody() throws Exception {
        Path file = dir.resolve("broken.json");
        Files.writeString(file, "{not json");
        TenantRegistry r = new TenantRegistry(file, 5, 300);
        assertThat(r.list()).isEmpty();
        assertThat(r.authenticate("ant_alice_00000000000000000000000000000000")).isEmpty();
    }
}
