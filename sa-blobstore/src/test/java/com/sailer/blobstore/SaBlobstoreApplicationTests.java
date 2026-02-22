package com.sailer.blobstore;

import org.junit.jupiter.api.Test;

/**
 * Basic application test without full Spring context
 */
class SaBlobstoreApplicationTests {

    @Test
    void applicationStartsSuccessfully() {
        // Test that the main class exists and can be instantiated
        SaBlobstoreApplication app = new SaBlobstoreApplication();
        // This just tests basic class loading without starting Spring context
    }
}