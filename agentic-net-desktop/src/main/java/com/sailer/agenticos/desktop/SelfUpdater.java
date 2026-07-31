package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;

/**
 * Tray-triggered update. The model stays deliberately simple: shut everything
 * down, replace the app, relaunch — data lives in ~/.agenticos and is untouched.
 *
 * macOS: downloads the release dmg, verifies it against SHA256SUMS.txt, then a
 * detached helper waits for this process to exit, swaps the .app bundle in place
 * and relaunches it. Linux: package installs need root, so we download + verify
 * the right package and hand the user the one install command.
 */
public final class SelfUpdater {

    private static final String DEFAULT_BASE =
        "https://github.com/alexejsailer/agentic-nets/releases/download";

    private SelfUpdater() {
    }

    static String baseUrl() {
        String prop = System.getProperty("agenticos.update.base");
        if (prop != null && !prop.isBlank()) {
            return prop;
        }
        String env = System.getenv("AGENTICOS_UPDATE_BASE");
        return env != null && !env.isBlank() ? env : DEFAULT_BASE;
    }

    static boolean isMac() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac");
    }

    static String artifactName(String version) {
        String rawArch = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
        boolean arm = rawArch.contains("aarch64") || rawArch.contains("arm");
        if (isMac()) {
            return "AgenticNetOS-" + version + "-macos-" + (arm ? "arm64" : "x64") + ".dmg";
        }
        boolean deb = Files.exists(Path.of("/usr/bin/dpkg"));
        return "AgenticNetOS-" + version + "-linux-" + (arm ? "arm64" : "amd64") + (deb ? ".deb" : ".rpm");
    }

    /** Downloads the platform artifact for {@code version} and verifies its SHA-256. */
    public static Path downloadAndVerify(String version, Path destDir) throws IOException, InterruptedException {
        Files.createDirectories(destDir);
        String name = artifactName(version);
        String base = baseUrl() + "/v" + version + "/";
        HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(10))
            .build();

        Path file = destDir.resolve(name);
        HttpResponse<Path> download = http.send(
            HttpRequest.newBuilder(URI.create(base + name)).timeout(Duration.ofMinutes(15)).GET().build(),
            HttpResponse.BodyHandlers.ofFile(file));
        if (download.statusCode() != 200) {
            throw new IOException("download failed (" + download.statusCode() + "): " + base + name);
        }

        HttpResponse<String> sums = http.send(
            HttpRequest.newBuilder(URI.create(base + "SHA256SUMS.txt")).timeout(Duration.ofSeconds(30)).GET().build(),
            HttpResponse.BodyHandlers.ofString());
        if (sums.statusCode() != 200) {
            throw new IOException("SHA256SUMS.txt missing for v" + version);
        }
        String expected = sums.body().lines()
            .filter(line -> line.endsWith(name))
            .map(line -> line.split("\\s+")[0])
            .findFirst()
            .orElseThrow(() -> new IOException(name + " not listed in SHA256SUMS.txt"));
        String actual = sha256(file);
        if (!expected.equalsIgnoreCase(actual)) {
            Files.deleteIfExists(file);
            throw new IOException("checksum mismatch for " + name + " — download discarded");
        }
        return file;
    }

    /**
     * Spawns the detached applier (wait for pid → mount dmg → swap bundle →
     * relaunch), then runs {@code quit}. Never returns normally to interactive use.
     */
    public static void applyOnMacAndRestart(Path dmg, Path appBundle, Path updateDir, Runnable quit)
            throws IOException {
        applyOnMacAndRestartForPid(dmg, appBundle, updateDir, ProcessHandle.current().pid());
        quit.run();
    }

    private static String sha256(Path file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(Files.readAllBytes(file)));
        } catch (Exception e) {
            throw new IOException("sha256 failed for " + file, e);
        }
    }

    /** Headless entry for testing: {@code SelfUpdater <version> <appBundle> <waitPid>}. */
    public static void main(String[] args) throws Exception {
        Path updateDir = Path.of(System.getProperty("user.home"), ".agenticos", "desktop", "update");
        Path pkg = downloadAndVerify(args[0], updateDir);
        System.out.println("downloaded+verified: " + pkg);
        if (isMac() && args.length >= 3) {
            long pid = Long.parseLong(args[2]);
            applyOnMacAndRestartForPid(pkg, Path.of(args[1]), updateDir, pid);
            System.out.println("applier spawned (waiting for pid " + pid + ")");
        }
    }

    static void applyOnMacAndRestartForPid(Path dmg, Path appBundle, Path updateDir, long pid)
            throws IOException {
        Path script = updateDir.resolve("apply-update.sh");
        Path mount = updateDir.resolve("mnt");
        Files.writeString(script, """
            #!/bin/bash
            exec >> "$(dirname "$0")/apply-update.log" 2>&1
            PID="$1"; DMG="$2"; APP="$3"; MNT="$4"
            echo "$(date) waiting for pid $PID"
            for i in $(seq 1 180); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
            hdiutil detach "$MNT" >/dev/null 2>&1 || true
            # yes | : the release dmg embeds the EULA as an SLA — accept non-interactively
            yes | hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" || exit 1
            [ -d "$MNT/AgenticNetOS.app" ] || { echo "no app in dmg"; hdiutil detach "$MNT"; exit 1; }
            rm -rf "$APP"
            ditto "$MNT/AgenticNetOS.app" "$APP"
            hdiutil detach "$MNT" >/dev/null 2>&1 || true
            echo "$(date) relaunching $APP"
            open "$APP"
            """);
        script.toFile().setExecutable(true);
        new ProcessBuilder("/bin/bash", script.toString(),
                String.valueOf(pid), dmg.toString(), appBundle.toString(), mount.toString())
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectErrorStream(true)
            .start();
    }
}
