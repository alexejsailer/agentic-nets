package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DesktopIntegrationTest {

    @TempDir
    Path tempDir;

    @Test
    void desktopEntryPointsAtLauncherAndIcon() {
        String entry = DesktopIntegration.desktopEntry(
            Path.of("/opt/agenticnetos/bin/AgenticNetOS"),
            Path.of("/home/u/.local/share/icons/agenticnetos.png"),
            false);
        assertTrue(entry.contains("Exec=/opt/agenticnetos/bin/AgenticNetOS"));
        assertTrue(entry.contains("Icon=/home/u/.local/share/icons/agenticnetos.png"));
        assertTrue(entry.contains("Terminal=false"));
        assertFalse(entry.contains("Autostart"));
        assertTrue(DesktopIntegration.desktopEntry(
            Path.of("/opt/agenticnetos/bin/AgenticNetOS"), Path.of("/i.png"), true)
            .contains("X-GNOME-Autostart-enabled=true"));
    }

    @Test
    void startAtLoginTogglesTheLoginFile() throws Exception {
        String previousHome = System.getProperty("user.home");
        try {
            System.setProperty("user.home", tempDir.toString());
            // an app-bundle-shaped appDir so launcherBinary() resolves
            DesktopConfig config = new DesktopConfig(
                tempDir.resolve("AgenticNetOS.app").resolve("Contents").resolve("app"));

            assertFalse(DesktopIntegration.isStartAtLoginEnabled());
            assertTrue(DesktopIntegration.setStartAtLogin(true, config));
            assertTrue(DesktopIntegration.isStartAtLoginEnabled());
            String content = Files.readString(DesktopIntegration.startAtLoginFile());
            assertTrue(content.contains("AgenticNetOS"));

            assertFalse(DesktopIntegration.setStartAtLogin(false, config));
            assertFalse(DesktopIntegration.isStartAtLoginEnabled());
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }
}
