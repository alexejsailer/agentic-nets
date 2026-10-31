package com.sailer.agenticos.desktop;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Studio's voice under the launcher: started when speech is set up here, optional, never blocking the stack. */
class SpeechSupervisionTest {

    @TempDir
    Path tempDir;

    private <T> T withHome(String properties, boolean speechSetUp, boolean bundled, Function<DesktopConfig, T> body) throws Exception {
        String previousHome = System.getProperty("user.home");
        Path home = Files.createTempDirectory(tempDir, "home"); // one home per case: nothing leaks between them
        try {
            System.setProperty("user.home", home.toString());
            Path desktopDir = home.resolve(".agenticos/desktop");
            Files.createDirectories(desktopDir);
            Files.writeString(desktopDir.resolve("desktop.properties"), "llm.provider=disabled\n" + properties);
            if (speechSetUp) Files.createDirectories(home.resolve(".agenticos/speech"));
            Path app = home.resolve("app");
            if (bundled) {
                Files.createDirectories(app.resolve("speech"));
                Files.writeString(app.resolve("speech/speech_service.py"), "# test\n");
            }
            return body.apply(new DesktopConfig(app));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void speechSetUpHereIsSupervisedAsAnOptionalServiceOnItsPort() throws Exception {
        // A PATH in this platform's own form (':' here, ';' on Windows).
        String path = String.join(File.pathSeparator, System.getProperty("java.io.tmpdir"), System.getProperty("user.dir"));
        ServiceSpec spec = withHome("", true, true, config -> Main.speechSpec(config, Map.of("PATH", path)));
        assertEquals("speech", spec.name());
        assertTrue(spec.optional());
        assertEquals("http://127.0.0.1:8092/health", spec.healthUrl());
        assertEquals("8092", spec.env().get("SPEECH_PORT"));
        assertEquals("127.0.0.1", spec.env().get("SPEECH_HOST"));
        assertTrue(spec.command().get(1).endsWith("speech_service.py"));
        // a port named in speech.url is the one the service binds and the one the health check asks
        ServiceSpec moved = withHome("speech.url=http://127.0.0.1:8099\n", true, true, config -> Main.speechSpec(config, Map.of()));
        assertEquals("http://127.0.0.1:8099/health", moved.healthUrl());
        assertEquals("8099", moved.env().get("SPEECH_PORT"));
    }

    @Test
    void nothingStartsWhenSpeechWasNeverSetUpIsTurnedOffServedElsewhereOrNotBundled() throws Exception {
        assertNull(withHome("", false, true, config -> Main.speechSpec(config, Map.of())));
        assertNull(withHome("speech.supervise=false\n", true, true, config -> Main.speechSpec(config, Map.of())));
        assertNull(withHome("speech.url=http://studio-voice.lan:8092\n", true, true, config -> Main.speechSpec(config, Map.of())));
        assertNull(withHome("", true, false, config -> Main.speechSpec(config, Map.of())));
        // asked for explicitly, it runs even before the models are in place
        assertTrue(withHome("speech.supervise=true\n", false, true, config -> Main.speechSpec(config, Map.of())).optional());
    }

    @Test
    void theInterpreterIsTheSettingThenTheVenvThenPython3OnThePath() throws Exception {
        Assumptions.assumeTrue(File.separatorChar == '/');
        assertEquals("/opt/py/bin/python3", withHome("speech.python=/opt/py/bin/python3\n", true, true,
                config -> Main.speechPython(config, "/usr/bin")));
        Path bin = tempDir.resolve("bin");
        Files.createDirectories(bin);
        Path python = Files.createFile(bin.resolve("python3"));
        python.toFile().setExecutable(true);
        assertEquals(python.toString(), withHome("", true, true, config -> Main.speechPython(config, "/nowhere:" + bin)));
        String venvPython = withHome("", true, true, config -> {
            try {
                Path venv = config.speechDataDir().resolve("venv/bin/python3");
                Files.createDirectories(venv.getParent());
                Files.createFile(venv).toFile().setExecutable(true);
                return Main.speechPython(config, bin.toString());
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        assertTrue(venvPython.endsWith(".agenticos/speech/venv/bin/python3"), venvPython);
    }

    @Test
    void aPathEntryTheFileSystemCannotReadIsSkippedNotFatal() throws Exception {
        // On Windows a Unix-style PATH arrives as one entry with ':' in it, which is no valid path there.
        String odd = "/usr/bin:/bin" + File.pathSeparator + "\u0000bad";
        String python = withHome("", true, true, config -> Main.speechPython(config, odd));
        assertTrue(python.equals("python3") || python.equals("python") || python.endsWith("python3") || python.endsWith("python.exe"), python);
    }

    @Test
    void anOptionalServiceThatCannotStartIsUnavailableAndTheStackRunsOn() throws Exception {
        Assumptions.assumeTrue(File.separatorChar == '/');
        ServiceSpec broken = new ServiceSpec("speech", "Speech (local voice)", List.of("/bin/sh", "-c", "exit 3"), Map.of(),
                tempDir.resolve("run/speech"), "http://127.0.0.1:1/health", 5, true);
        Supervisor supervisor = new Supervisor(List.of(broken), tempDir.resolve("logs"));
        supervisor.startAll(); // must not throw
        assertEquals(Supervisor.Status.UNAVAILABLE, supervisor.statuses().get("Speech (local voice)"));
        assertTrue(supervisor.allRunning(), "an optional service does not count against the stack");
        supervisor.stopAll();
    }

    @Test
    void anOptionalServiceAlreadyAnsweringOnItsPortIsUsedAsItIs() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/health", exchange -> { exchange.sendResponseHeaders(200, -1); exchange.close(); });
        server.start();
        try {
            int port = server.getAddress().getPort();
            ServiceSpec spec = new ServiceSpec("speech", "Speech (local voice)", List.of("/no/such/interpreter"), Map.of(),
                    tempDir.resolve("run/speech"), "http://127.0.0.1:" + port + "/health", 5, true);
            Supervisor supervisor = new Supervisor(List.of(spec), tempDir.resolve("logs"));
            supervisor.startAll();
            assertEquals(Supervisor.Status.RUNNING, supervisor.statuses().get("Speech (local voice)"));
            supervisor.stopAll();
        } finally {
            server.stop(0);
        }
    }
}
