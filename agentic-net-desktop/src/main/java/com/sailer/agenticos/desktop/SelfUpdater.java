package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
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

    static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    static String artifactName(String version) {
        String rawArch = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
        boolean arm = rawArch.contains("aarch64") || rawArch.contains("arm");
        if (isMac()) {
            return "AgenticNetOS-" + version + "-macos-" + (arm ? "arm64" : "x64") + ".dmg";
        }
        if (isWindows()) {
            return "AgenticNetOS-" + version + "-windows-" + (arm ? "arm64" : "x64") + ".msi";
        }
        boolean deb = Files.exists(Path.of("/usr/bin/dpkg"));
        return "AgenticNetOS-" + version + "-linux-" + (arm ? "arm64" : "amd64") + (deb ? ".deb" : ".rpm");
    }

    static String installCommand(Path packageFile) {
        String name = packageFile.getFileName().toString();
        if (name.endsWith(".msi")) {
            return "msiexec /i \"" + packageFile.toAbsolutePath() + "\"";
        }
        String path = packageFile.toAbsolutePath().toString().replace("'", "'\"'\"'");
        if (name.endsWith(".deb")) {
            return "sudo apt install '" + path + "'";
        }
        if (name.endsWith(".rpm")) {
            return "sudo dnf install '" + path + "'";
        }
        return "open '" + path + "'";
    }

    /**
     * Windows: stop every child service FIRST, then hand the msi to a detached
     * cmd script that waits ~2s — long enough for THIS process to exit — before
     * invoking msiexec, and only then quit.
     *
     * <p>The ordering is the whole fix. The previous version started msiexec and
     * THEN began the multi-second shutdown, so the installer's files-in-use scan
     * always found the app running. Restart Manager cannot close the background
     * node/java children (no windows, not RM-registered), and force-closing the
     * tray process skips the JVM shutdown hook and ORPHANS them — an orphaned MCP
     * node.exe holds handles under app\mcp\, the install dies on "error writing
     * to file", and cancelling rolls back a half-done upgrade with the OLD version
     * already removed, leaving nothing installed at all (field report, 2.40.0).</p>
     */
    static void launchWindowsInstallerAndQuit(Path msi, Path installRoot, Path runRoot,
                                              Runnable stopServices, Runnable quit)
            throws IOException {
        launchWindowsInstallerAndQuit(msi, stopServices, quit,
            m -> spawnWindowsInstaller(m, installRoot),
            () -> InstallProcesses.killAllUnder(installRoot, runRoot,
                Duration.ofSeconds(15), Duration.ofSeconds(10)));
    }

    /** Spawner and sweeper injected so the stop→sweep→spawn→quit ordering is testable off-Windows. */
    static void launchWindowsInstallerAndQuit(Path msi, Runnable stopServices, Runnable quit,
                                              InstallerSpawner spawner, OrphanSweeper sweeper)
            throws IOException {
        stopServices.run();
        // The supervisor stops what THIS launcher started; the sweep kills BY EVIDENCE
        // whatever else runs from the install dir — orphans of a force-killed previous
        // instance, a second launcher — and waits until every kill has landed.
        requireAllDead(sweeper.sweep());
        spawner.spawn(msi);
        quit.run();
    }

    /**
     * Fail CLOSED. Handing msiexec a fight over a locked file does not fail the update,
     * it rolls back a half-done upgrade whose old version is already removed — an aborted
     * update with instructions beats no installation at all.
     */
    static void requireAllDead(List<ProcessHandle> survivors) throws IOException {
        if (!survivors.isEmpty()) {
            String named = survivors.stream()
                .map(p -> "pid " + p.pid() + " (" + p.info().command().orElse("unknown image") + ")")
                .collect(java.util.stream.Collectors.joining(", "));
            throw new IOException("update aborted: " + survivors.size()
                + " process(es) in the install directory would not exit or were not positively "
                + "identifiable as ours — " + named
                + " — end them in Task Manager or reboot, then update again");
        }
    }

    /** Stop known children, then sweep the install dir; used by the macOS path too. */
    static void stopAndSweep(Runnable stopServices, Path installRoot, Path runRoot) throws IOException {
        stopServices.run();
        requireAllDead(InstallProcesses.killAllUnder(installRoot, runRoot,
            Duration.ofSeconds(15), Duration.ofSeconds(10)));
    }

    @FunctionalInterface
    interface InstallerSpawner {
        void spawn(Path msi) throws IOException;
    }

    @FunctionalInterface
    interface OrphanSweeper {
        List<ProcessHandle> sweep();
    }

    private static void spawnWindowsInstaller(Path msi, Path installRoot) throws IOException {
        // A script file, not an inline `cmd /c "a & b"` string: ProcessBuilder's Windows
        // argument quoting around an embedded quoted path inside a compound command is
        // exactly the kind of thing that works on one machine and not another.
        Path script = Files.createTempFile("agenticos-update-", ".cmd");
        Files.writeString(script, windowsInstallScript(msi, installRoot));
        new ProcessBuilder("cmd", "/c", script.toAbsolutePath().toString()).start();
    }

    /**
     * The ping is a ~2s delay for the launcher itself: its exe lives in the install
     * dir too, and it exits AFTER spawning this script. Without the delay msiexec's
     * files-in-use scan can still catch the dying launcher process.
     *
     * <p>{@code /passive} shows a progress bar and needs no clicks — the bare {@code /i}
     * this used to run opened an INTERACTIVE wizard from a process that had just quit,
     * which routinely appeared behind other windows: the user watched the app shut down
     * and then saw nothing at all (field report, 2.42.0 era). {@code /l*v} logs beside
     * the msi. On success (0, or 3010 = success-wants-reboot) the app is RELAUNCHED —
     * the old script simply ended, so even a perfect update looked like a silent death.
     * On failure the log opens in Notepad: a visible artifact instead of silence.</p>
     */
    static String windowsInstallScript(Path msi, Path installRoot) {
        Path log = msi.toAbsolutePath().resolveSibling("install.log");
        Path exe = installRoot.toAbsolutePath().resolve("AgenticNetOS.exe");
        return "@echo off\r\n"
            + "ping -n 3 127.0.0.1 >nul\r\n"
            + "msiexec /i \"" + msi.toAbsolutePath() + "\" /passive /norestart /l*v \"" + log + "\"\r\n"
            + "if %errorlevel%==0 goto relaunch\r\n"
            + "if %errorlevel%==3010 goto relaunch\r\n"
            + "start \"\" notepad \"" + log + "\"\r\n"
            + "exit /b 1\r\n"
            + ":relaunch\r\n"
            + "start \"\" \"" + exe + "\"\r\n";
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

        HttpResponse<byte[]> sums = http.send(
            HttpRequest.newBuilder(URI.create(base + "SHA256SUMS.txt")).timeout(Duration.ofSeconds(30)).GET().build(),
            HttpResponse.BodyHandlers.ofByteArray());
        if (sums.statusCode() != 200) {
            throw new IOException("SHA256SUMS.txt missing for v" + version);
        }
        // The checksums ride the same channel as the artifacts, so alone they only
        // catch corruption. Trust comes from this detached Ed25519 signature checked
        // against the key pinned below — GitHub is just transport after this line.
        HttpResponse<String> sig = http.send(
            HttpRequest.newBuilder(URI.create(base + "SHA256SUMS.txt.sig")).timeout(Duration.ofSeconds(30)).GET().build(),
            HttpResponse.BodyHandlers.ofString());
        if (sig.statusCode() != 200) {
            throw new IOException("release v" + version + " is unsigned (SHA256SUMS.txt.sig missing) — refusing");
        }
        verifyChecksumSignature(sums.body(), sig.body());
        String expected = new String(sums.body(), java.nio.charset.StandardCharsets.UTF_8).lines()
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

    /**
     * Raw Ed25519 public key for release checksum signatures. The private key
     * lives only on the maintainer machine (never in any repo or release); this
     * pin means a compromised GitHub account cannot feed updates to existing
     * installs. Also published in SECURITY.md and on agentic-nets.com.
     */
    static final String UPDATE_PUBLIC_KEY_B64 = "wJHaHlpGxdtKjeOGVZN5/hfbI1P9Pvjw2xY/UIW6qHw=";

    static void verifyChecksumSignature(byte[] sumsBytes, String sigBase64) throws IOException {
        try {
            byte[] raw = java.util.Base64.getDecoder().decode(UPDATE_PUBLIC_KEY_B64);
            byte[] prefix = HexFormat.of().parseHex("302a300506032b6570032100");
            byte[] spki = new byte[prefix.length + raw.length];
            System.arraycopy(prefix, 0, spki, 0, prefix.length);
            System.arraycopy(raw, 0, spki, prefix.length, raw.length);
            java.security.PublicKey key = java.security.KeyFactory.getInstance("Ed25519")
                .generatePublic(new java.security.spec.X509EncodedKeySpec(spki));
            java.security.Signature verifier = java.security.Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(sumsBytes);
            byte[] sigBytes = java.util.Base64.getDecoder().decode(sigBase64.trim());
            if (!verifier.verify(sigBytes)) {
                throw new IOException("SHA256SUMS.txt signature INVALID — refusing the update");
            }
        } catch (java.security.GeneralSecurityException | IllegalArgumentException e) {
            throw new IOException("checksum signature verification failed: " + e.getMessage(), e);
        }
    }

    private static String sha256(Path file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (DigestInputStream in = new DigestInputStream(Files.newInputStream(file), digest)) {
                in.transferTo(java.io.OutputStream.nullOutputStream());
            }
            return HexFormat.of().formatHex(digest.digest());
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
            NEW="$APP.update-new"; OLD="$APP.update-old"
            echo "$(date) waiting for pid $PID"
            for i in $(seq 1 180); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
            hdiutil detach "$MNT" >/dev/null 2>&1 || true
            mkdir -p "$MNT"
            # yes | : the release dmg embeds the EULA as an SLA — accept non-interactively
            yes | hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" || exit 1
            [ -d "$MNT/AgenticNetOS.app" ] || { echo "no app in dmg"; hdiutil detach "$MNT"; exit 1; }
            rm -rf "$NEW" "$OLD"
            ditto "$MNT/AgenticNetOS.app" "$NEW" || { hdiutil detach "$MNT"; exit 1; }
            [ -x "$NEW/Contents/MacOS/AgenticNetOS" ] || {
              echo "new app is incomplete"; rm -rf "$NEW"; hdiutil detach "$MNT"; exit 1;
            }
            # a SIGNED replacement must verify; an unsigned one passes (pre-notarization builds)
            CS_OUT=$(codesign --verify --deep --strict "$NEW" 2>&1) || {
              case "$CS_OUT" in
                *"not signed at all"*) : ;;
                *) echo "codesign verify failed: $CS_OUT"; rm -rf "$NEW"; hdiutil detach "$MNT"; exit 1 ;;
              esac
            }
            hdiutil detach "$MNT" >/dev/null 2>&1 || true
            mv "$APP" "$OLD" || exit 1
            if ! mv "$NEW" "$APP"; then
              echo "swap failed; restoring previous app"
              mv "$OLD" "$APP"
              exit 1
            fi
            echo "$(date) relaunching $APP"
            if open "$APP"; then
              rm -rf "$OLD"
            else
              echo "relaunch failed; restoring previous app"
              rm -rf "$APP"
              mv "$OLD" "$APP"
              open "$APP"
              exit 1
            fi
            """);
        script.toFile().setExecutable(true);
        new ProcessBuilder("/bin/bash", script.toString(),
                String.valueOf(pid), dmg.toString(), appBundle.toString(), mount.toString())
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectErrorStream(true)
            .start();
    }
}
