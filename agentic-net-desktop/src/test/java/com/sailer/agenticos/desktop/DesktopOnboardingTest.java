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
            assertTrue(html.contains("Design and create a developer persona"));
            assertTrue(html.contains("Create a health coach"));
            assertTrue(html.contains("llmMode:\"bash\""));
            assertTrue(html.contains("context-curator"));

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

    /**
     * The Windows update bug WAS an ordering bug: msiexec started first and raced the
     * multi-second shutdown, so its files-in-use scan always found the app running,
     * Restart Manager orphaned the windowless node/java children, and the install died
     * on a handle one of them still held — then rolled back to nothing installed.
     */
    @Test
    void windowsUpdateStopsSweepsThenSpawnsTheInstaller() throws Exception {
        List<String> order = new java.util.ArrayList<>();

        SelfUpdater.launchWindowsInstallerAndQuit(
            Path.of("/tmp/AgenticNetOS.msi"),
            () -> order.add("stop"),
            () -> order.add("quit"),
            msi -> order.add("spawn"),
            () -> { order.add("sweep"); return List.of(); });

        assertEquals(List.of("stop", "sweep", "spawn", "quit"), order);
    }

    /**
     * Fail CLOSED on a survivor. Handing msiexec a locked file does not fail the update —
     * it rolls back a half-done upgrade whose old version is already removed, leaving no
     * installation at all. An aborted update with instructions beats that every time.
     */
    @Test
    void windowsUpdateRefusesToStartTheInstallerWhileAProcessSurvives() {
        List<String> order = new java.util.ArrayList<>();

        java.io.IOException refused = org.junit.jupiter.api.Assertions.assertThrows(
            java.io.IOException.class,
            () -> SelfUpdater.launchWindowsInstallerAndQuit(
                Path.of("/tmp/AgenticNetOS.msi"),
                () -> order.add("stop"),
                () -> order.add("quit"),
                msi -> order.add("spawn"),
                () -> List.of(ProcessHandle.current()))); // stands in for an unkillable orphan

        assertTrue(refused.getMessage().contains("update aborted"));
        assertTrue(refused.getMessage().contains("Task Manager"));
        // neither the installer nor the quit may run — the app stays up and reports the error
        assertEquals(List.of("stop"), order);
    }

    @Test
    void windowsInstallScriptDelaysBeforeMsiexecAndQuotesThePath() {
        // a path WITH A SPACE, built platform-neutrally — a hardcoded C:\ literal is not
        // absolute on the POSIX JVM this test runs on, so toAbsolutePath() would mangle it
        Path msiPath = Path.of("update dir", "update.msi");
        Path installRoot = Path.of("install root");
        String script = SelfUpdater.windowsInstallScript(msiPath, installRoot);

        int delay = script.indexOf("ping -n 3");
        int msi = script.indexOf("msiexec /i");
        // the delay exists for the launcher's own exe and must come FIRST
        assertTrue(delay >= 0 && msi > delay);
        assertTrue(script.contains("msiexec /i \"" + msiPath.toAbsolutePath() + "\""));
    }

    /**
     * The bare interactive `msiexec /i` this script used to run opened a wizard BEHIND other
     * windows from a process that had just quit — the user watched the app shut down and then
     * saw nothing (field report). The script must therefore need no clicks, log verbosely,
     * relaunch the app on success (including 3010 = success-wants-reboot), and on failure
     * open the log — a visible artifact instead of silence.
     */
    @Test
    void windowsInstallScriptIsPassiveLoggedAndRelaunches() {
        Path msiPath = Path.of("update dir", "update.msi");
        Path installRoot = Path.of("install root");
        String script = SelfUpdater.windowsInstallScript(msiPath, installRoot);

        assertTrue(script.contains("/passive"), "no clicks: a hidden wizard stalls the update forever");
        assertTrue(script.contains("/norestart"));
        assertTrue(script.contains("/l*v"), "failures must leave a log");
        assertTrue(script.contains("if %errorlevel%==3010 goto relaunch"), "3010 is a success");
        assertTrue(script.contains("start \"\" notepad"), "failure must be VISIBLE");
        assertTrue(script.contains("AgenticNetOS.exe"), "success must relaunch the app");
        // relaunch strictly after the msiexec call
        assertTrue(script.indexOf("AgenticNetOS.exe") > script.indexOf("msiexec /i"));
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
