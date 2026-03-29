package com.sailer.agenticos.agenticnetexecutor.model.util;

import java.util.UUID;

/**
 * Application-wide constants for AgenticNetOS, including fixed root UUID for the tree structure.
 */
public final class AgenticOsConstants {

    private AgenticOsConstants() {
        // prevent instantiation
    }

    /**
     * Root UUID for the tree structure.
     * This value is static and should never be changed.
     */
    public static final UUID ROOT_NODE_UUID = UUID.fromString("00000000-0000-0000-0000-000000000001");
}
