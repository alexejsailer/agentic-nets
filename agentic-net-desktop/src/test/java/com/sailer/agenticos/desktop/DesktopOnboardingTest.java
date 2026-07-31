package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DesktopOnboardingTest {

    @TempDir
    Path tempDir;

    @Test
    void codexSnippetCarriesTheLoopbackUrlAndBearerHeader() {
        String previousHome = System.getProperty("user.home");
        try {
            System.setProperty("user.home", tempDir.toString());
            DesktopConfig config = new DesktopConfig(tempDir.resolve("app"));
            TrayUi tray = new TrayUi(
                config,
                new Supervisor(List.of(), config.logsDir()),
                new GuiServer(config.guiDir(), DesktopConfig.GATEWAY_PORT, () -> "test-secret"),
                () -> { }
            );

            String snippet = tray.codexMcpConfig();

            assertTrue(snippet.contains("[mcp_servers.agenticnets]"));
            assertTrue(snippet.contains("http://127.0.0.1:8091/mcp"));
            assertTrue(snippet.contains("Authorization = \"Bearer "));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void packageInstallCommandMatchesTheLinuxPackageType() {
        assertEquals(
            "sudo apt install '/tmp/AgenticNetOS.deb'",
            SelfUpdater.installCommand(Path.of("/tmp/AgenticNetOS.deb"))
        );
        assertEquals(
            "sudo dnf install '/tmp/AgenticNetOS.rpm'",
            SelfUpdater.installCommand(Path.of("/tmp/AgenticNetOS.rpm"))
        );
    }
}
