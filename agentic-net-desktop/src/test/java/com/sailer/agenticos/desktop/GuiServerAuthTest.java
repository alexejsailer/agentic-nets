package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The desktop llm-settings write endpoint must require the admin scope, not merely a valid token
 * (a readonly token passes the gateway GET probe). {@link GuiServer#hasAdminScope} enforces that.
 */
class GuiServerAuthTest {

    private static String bearer(String scope) {
        String header = b64("{\"alg\":\"RS256\"}");
        String payload = b64("{\"sub\":\"x\",\"scope\":\"" + scope + "\"}");
        return "Bearer " + header + "." + payload + ".sig";
    }

    private static String b64(String json) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void adminScopeAccepted() {
        assertTrue(GuiServer.hasAdminScope(bearer("agenticos admin")));
    }

    @Test
    void readonlyAndExecutorRejected() {
        assertFalse(GuiServer.hasAdminScope(bearer("agenticos readonly")));
        assertFalse(GuiServer.hasAdminScope(bearer("executor")));
        assertFalse(GuiServer.hasAdminScope(bearer("share")));
    }

    @Test
    void malformedRejected() {
        assertFalse(GuiServer.hasAdminScope("Bearer not-a-jwt"));
        assertFalse(GuiServer.hasAdminScope("Bearer "));
    }
}
