package com.sailer.agenticos.agenticnetgateway.tenant;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TenantKeysTest {

    @Test
    void tenantIdsAreShortLowercaseAndNeverReserved() {
        assertThat(TenantKeys.validTenantId("alice")).isTrue();
        assertThat(TenantKeys.validTenantId("a1b")).isTrue();
        assertThat(TenantKeys.validTenantId("al")).isFalse();
        assertThat(TenantKeys.validTenantId("Alice")).isFalse();
        assertThat(TenantKeys.validTenantId("al-ice")).isFalse();
        assertThat(TenantKeys.validTenantId("1abc")).isFalse();
        assertThat(TenantKeys.validTenantId("default")).isFalse();
        assertThat(TenantKeys.validTenantId("system")).isFalse();
        assertThat(TenantKeys.validTenantId(null)).isFalse();
    }

    @Test
    void ownershipIsThePrefixAndADashNeverMakesItAmbiguous() {
        assertThat(TenantKeys.ownsModel("alice", "alice-notes")).isTrue();
        assertThat(TenantKeys.ownsModel("alice", "alice-")).isFalse();
        assertThat(TenantKeys.ownsModel("alice", "alice")).isFalse();
        assertThat(TenantKeys.ownsModel("ali", "alice-notes")).isFalse();
        assertThat(TenantKeys.ownsModel("alice", "alicex-notes")).isFalse();
        assertThat(TenantKeys.ownsModel("alice", "alice-../x")).isFalse();
        assertThat(TenantKeys.ownsModel("alice", "default")).isFalse();
    }

    @Test
    void keysNameTheirOwnerAndOnlyTheirHashIsKept() {
        String key = TenantKeys.newTenantKey("alice");
        assertThat(key).startsWith("ant_alice_").hasSize("ant_alice_".length() + 32);
        assertThat(TenantKeys.tenantOfKey(key)).isEqualTo("alice");
        assertThat(TenantKeys.matches(TenantKeys.hash(key), key)).isTrue();
        assertThat(TenantKeys.matches(TenantKeys.hash(key), key + "0")).isFalse();
        String exec = TenantKeys.newExecutorKey("alice", "laptop");
        assertThat(TenantKeys.executorOfKey(exec)).containsExactly("alice", "laptop");
        assertThat(TenantKeys.tenantOfKey(exec)).isNull();
        assertThat(TenantKeys.executorId("alice", "laptop")).isEqualTo("alice-laptop");
    }
}
