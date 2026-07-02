package com.sailer.agenticos.agenticnetexecutor.util;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Tests for {@link HostUtil} — parses the compact {@code modelId@host:port} host strings that appear in every
 * distributed inscription preset/postset. The executor uses these to decide which model to query and at which
 * base URL, so a parsing regression would silently route work to the wrong node (or none). Pins the modelId
 * split, the http:// defaulting, scheme preservation, and the legacy no-{@code @} form. Pure static utility.
 */
class HostUtilTest {

    // ---- extractModelId ----

    @Test
    void extractsModelIdBeforeTheAtSeparator() {
        assertEquals("default", HostUtil.extractModelId("default@localhost:8080"));
        assertEquals("user-leo", HostUtil.extractModelId("user-leo@node.internal:8080"));
    }

    @Test
    void legacyHostWithoutAtHasNullModelId() {
        assertNull(HostUtil.extractModelId("localhost:8080"));
    }

    @Test
    void extractModelIdRejectsNullOrBlank() {
        assertThrows(IllegalArgumentException.class, () -> HostUtil.extractModelId(null));
        assertThrows(IllegalArgumentException.class, () -> HostUtil.extractModelId("   "));
    }

    @Test
    void extractModelIdUsesTheFirstAtSeparator() {
        // Only the first '@' delimits the modelId; anything after is host territory.
        assertEquals("a", HostUtil.extractModelId("a@b@localhost:8080"));
    }

    // ---- extractBaseUrl ----

    @Test
    void extractsBaseUrlAndAddsHttpPrefix() {
        assertEquals("http://localhost:8080", HostUtil.extractBaseUrl("default@localhost:8080"));
    }

    @Test
    void extractsBaseUrlFromLegacyHostWithoutModelId() {
        assertEquals("http://localhost:8080", HostUtil.extractBaseUrl("localhost:8080"));
    }

    @Test
    void preservesAnExplicitHttpScheme() {
        assertEquals("http://localhost:8080", HostUtil.extractBaseUrl("default@http://localhost:8080"));
        assertEquals("https://node.internal:8443", HostUtil.extractBaseUrl("m1@https://node.internal:8443"));
    }

    @Test
    void preservesHttpsWithoutModelId() {
        assertEquals("https://secure-node:443", HostUtil.extractBaseUrl("https://secure-node:443"));
    }

    @Test
    void extractBaseUrlRejectsNullOrBlank() {
        assertThrows(IllegalArgumentException.class, () -> HostUtil.extractBaseUrl(null));
        assertThrows(IllegalArgumentException.class, () -> HostUtil.extractBaseUrl(""));
    }
}
