package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
    void manualIsBundledRenderedAndReachableWithoutSigningIn() throws Exception {
        String previousHome = System.getProperty("user.home");
        System.setProperty("agenticos.desktop.version", "9.9.9");
        try {
            System.setProperty("user.home", tempDir.toString());
            DesktopConfig config = new DesktopConfig(tempDir.resolve("app"));
            GuiServer guiServer =
                new GuiServer(config.guiDir(), DesktopConfig.GATEWAY_PORT, () -> "test-secret");
            guiServer.enableDesktopApi(config, () -> { });

            byte[] rendered = guiServer.manualPage();
            assertNotNull(rendered, "manual.html must ship inside the launcher jar");
            String html = new String(rendered, java.nio.charset.StandardCharsets.UTF_8);

            // an unsubstituted placeholder would ship a literal __VERSION__ to the reader
            assertFalse(html.contains("__VERSION__"));
            assertTrue(html.contains("9.9.9"));
            // the sections a newcomer is sent here for
            assertTrue(html.contains("id=\"start\""));
            assertTrue(html.contains("id=\"use-cases\""));
            assertTrue(html.contains("readiness"));

            TrayUi tray = new TrayUi(
                config, new Supervisor(List.of(), config.logsDir()), guiServer, () -> { });
            // no ?once= nonce: the manual has to open while the gateway is still starting
            assertEquals("http://localhost:" + DesktopConfig.GUI_PORT + "/manual", tray.manualUrl());

            // Route precedence: serveStatic answers unknown paths with the SPA shell, so a
            // reordered handler would turn the manual into a blank Studio page rather than a 404.
            guiServer.start("127.0.0.1", 0);
            try {
                java.net.http.HttpResponse<String> response = java.net.http.HttpClient.newHttpClient()
                    .send(java.net.http.HttpRequest.newBuilder(
                            java.net.URI.create("http://127.0.0.1:" + guiServer.boundPort() + "/manual"))
                        .build(), java.net.http.HttpResponse.BodyHandlers.ofString());
                assertEquals(200, response.statusCode());
                assertEquals("text/html; charset=utf-8",
                    response.headers().firstValue("Content-Type").orElse(""));
                assertTrue(response.body().contains("Desktop Lite"));
            } finally {
                guiServer.stop();
            }
        } finally {
            System.clearProperty("agenticos.desktop.version");
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void packageInstallCommandMatchesThePackageType() {
        // absolute-path rendering is platform-specific (/tmp/x vs D:\tmp\x), so
        // assert the command shape around the path the JDK actually produces
        Path deb = Path.of("/tmp/AgenticNetOS.deb");
        Path rpm = Path.of("/tmp/AgenticNetOS.rpm");
        Path msi = Path.of("/tmp/AgenticNetOS.msi");
        assertEquals("sudo apt install '" + deb.toAbsolutePath() + "'",
            SelfUpdater.installCommand(deb));
        assertEquals("sudo dnf install '" + rpm.toAbsolutePath() + "'",
            SelfUpdater.installCommand(rpm));
        assertEquals("msiexec /i \"" + msi.toAbsolutePath() + "\"",
            SelfUpdater.installCommand(msi));
    }

    @Test
    void artifactNameFollowsTheOperatingSystem() {
        String previousOs = System.getProperty("os.name");
        try {
            System.setProperty("os.name", "Windows 11");
            assertTrue(SelfUpdater.artifactName("2.38.0").startsWith("AgenticNetOS-2.38.0-windows-"));
            assertTrue(SelfUpdater.artifactName("2.38.0").endsWith(".msi"));
            System.setProperty("os.name", "Mac OS X");
            assertTrue(SelfUpdater.artifactName("2.38.0").endsWith(".dmg"));
        } finally {
            System.setProperty("os.name", previousOs);
        }
    }
}
