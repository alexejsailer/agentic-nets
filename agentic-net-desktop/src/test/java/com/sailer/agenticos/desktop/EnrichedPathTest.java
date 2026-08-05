package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.io.File;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Children of the tray launcher must see the user's CLI install dirs. A Finder/tray-launched
 * app gets launchd's minimal PATH, and {@code llmMode:"bash"} personas then exit 127 on a
 * {@code claude} that works in every terminal — the flagship persona backend failing on the
 * flagship platform. These tests pin the enrichment rules, not the machine's actual dirs.
 */
class EnrichedPathTest {

    @Test
    void appendsOnlyExistingStandardDirsWithoutDuplicating() {
        Assumptions.assumeTrue(File.separatorChar == '/');
        // /usr/local/bin exists on every macOS; simulate launchd's minimal PATH.
        String enriched = Main.enrichedPath("/usr/bin:/bin:/usr/sbin:/sbin");
        assertTrue(enriched.startsWith("/usr/bin:/bin:/usr/sbin:/sbin"),
            "existing PATH must stay first so user overrides keep winning");
        assertTrue(enriched.contains("/usr/local/bin"), "standard dirs that exist are appended");

        // Idempotent: enriching an already-enriched PATH adds nothing.
        assertEquals(enriched, Main.enrichedPath(enriched));
    }

    @Test
    void windowsPathIsLeftUntouched() {
        Assumptions.assumeTrue(File.separatorChar == '\\');
        assertEquals(null, Main.enrichedPath("C:\\Windows\\system32"));
    }
}
