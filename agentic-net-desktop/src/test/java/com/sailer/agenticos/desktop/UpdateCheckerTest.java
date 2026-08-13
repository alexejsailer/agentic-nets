package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The release-comparison half of the updater. Field report (2.44.3 → 2.45.0): clicking
 * "Check for Updates" opened the Releases page, the user SAW the newer version there, and the
 * tray item never changed — because the click performed no check and the only thing that
 * relabels the item is a background poll that runs at startup and then once a day.
 * {@code newerVersionFrom} is what the on-demand path now asks.
 */
class UpdateCheckerTest {

    private static String body(String tag) {
        return "{\"url\":\"https://api.github.com/…\",\"tag_name\":\"" + tag + "\",\"name\":\"AgenticNetOS\"}";
    }

    @Test
    void reportsANewerReleaseRegardlessOfTheVPrefix() {
        assertEquals("2.45.0", UpdateChecker.newerVersionFrom(body("v2.45.0"), "2.44.3"));
        assertEquals("2.45.0", UpdateChecker.newerVersionFrom(body("2.45.0"), "2.44.3"));
    }

    @Test
    void staysSilentOnTheSameOrAnOlderRelease() {
        // null means "up to date" — the caller must NOT confuse it with a failed check.
        assertNull(UpdateChecker.newerVersionFrom(body("v2.45.0"), "2.45.0"));
        assertNull(UpdateChecker.newerVersionFrom(body("v2.44.3"), "2.45.0"));
    }

    @Test
    void aBodyWithoutATagIsNotAnUpdate() {
        assertNull(UpdateChecker.newerVersionFrom("{\"message\":\"Not Found\"}", "2.45.0"));
        assertNull(UpdateChecker.newerVersionFrom("", "2.45.0"));
        assertNull(UpdateChecker.newerVersionFrom(null, "2.45.0"));
    }

    @Test
    void comparesSegmentsNumericallyNotLexically() {
        // "2.9.0" vs "2.10.0" is the classic string-compare trap.
        assertTrue(UpdateChecker.isNewer("2.10.0", "2.9.0"));
        assertFalse(UpdateChecker.isNewer("2.9.0", "2.10.0"));
        assertTrue(UpdateChecker.isNewer("2.45.0", "2.44.3"));
        assertFalse(UpdateChecker.isNewer("2.45.0", "2.45.0"));
        // a shorter version is padded with zeros, not treated as greater
        assertTrue(UpdateChecker.isNewer("2.45.1", "2.45"));
        assertFalse(UpdateChecker.isNewer("2.45", "2.45.1"));
    }
}
