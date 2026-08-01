package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

/**
 * Per-user OS integration, all fail-soft: a Linux application-menu entry
 * (written on first launch inside a desktop session — packages stay free of
 * xdg postinst hooks so headless installs configure cleanly) and the
 * "Start at Login" toggle (XDG autostart on Linux, a LaunchAgent on macOS).
 */
public final class DesktopIntegration {

    private DesktopIntegration() {
    }

    private static boolean isLinux() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("linux");
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    private static Path home() {
        return Path.of(System.getProperty("user.home"));
    }

    /** True when a Linux graphical session is present (menu entries make sense). */
    static boolean linuxDesktopSession() {
        return isLinux() && (System.getenv("XDG_CURRENT_DESKTOP") != null
            || System.getenv("DISPLAY") != null
            || System.getenv("WAYLAND_DISPLAY") != null);
    }

    /** Installs the user-level menu entry + icon on Linux. No-op elsewhere. */
    public static void installLinuxMenuEntry(DesktopConfig config) {
        if (!linuxDesktopSession()) {
            return;
        }
        Path launcher = config.launcherBinary();
        if (launcher == null) {
            return; // dev run from a bare jar — nothing durable to point at
        }
        try {
            Path icon = home().resolve(".local/share/icons/agenticnetos.png");
            Files.createDirectories(icon.getParent());
            javax.imageio.ImageIO.write(IconGenerator.mark(128, true), "png", icon.toFile());

            Path entry = home().resolve(".local/share/applications/agenticnetos.desktop");
            Files.createDirectories(entry.getParent());
            Files.writeString(entry, desktopEntry(launcher, icon, false));
            System.out.println("[desktop] menu entry installed: " + entry);
        } catch (IOException e) {
            System.err.println("[desktop] menu entry install failed: " + e.getMessage());
        }
    }

    public static boolean isStartAtLoginEnabled() {
        return Files.exists(startAtLoginFile());
    }

    /** Creates or removes the login item. Returns the resulting state. */
    public static boolean setStartAtLogin(boolean enabled, DesktopConfig config) throws IOException {
        Path file = startAtLoginFile();
        if (!enabled) {
            Files.deleteIfExists(file);
            return false;
        }
        Path launcher = config.launcherBinary();
        if (launcher == null) {
            throw new IOException("not running from an installed app — install first");
        }
        Files.createDirectories(file.getParent());
        if (isLinux()) {
            Path icon = home().resolve(".local/share/icons/agenticnetos.png");
            Files.writeString(file, desktopEntry(launcher, icon, true));
        } else if (isWindows()) {
            // Startup-folder script — per-user, no elevation, no COM shortcut plumbing
            Files.writeString(file, "@echo off\r\nstart \"\" \"" + launcher.toAbsolutePath() + "\"\r\n");
        } else {
            Files.writeString(file, """
                <?xml version="1.0" encoding="UTF-8"?>
                <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
                <plist version="1.0">
                <dict>
                    <key>Label</key><string>com.sailer.agenticos.desktop</string>
                    <key>ProgramArguments</key><array><string>%s</string></array>
                    <key>RunAtLoad</key><true/>
                </dict>
                </plist>
                """.formatted(launcher.toAbsolutePath()));
        }
        return true;
    }

    static Path startAtLoginFile() {
        if (isLinux()) {
            return home().resolve(".config/autostart/agenticnetos.desktop");
        }
        if (isWindows()) {
            String appData = System.getenv("APPDATA");
            Path roaming = appData != null && !appData.isBlank()
                ? Path.of(appData) : home().resolve("AppData").resolve("Roaming");
            return roaming.resolve(Path.of("Microsoft", "Windows", "Start Menu",
                "Programs", "Startup", "AgenticNetOS.cmd"));
        }
        return home().resolve("Library/LaunchAgents/com.sailer.agenticos.desktop.plist");
    }

    static String desktopEntry(Path launcher, Path icon, boolean autostart) {
        return """
            [Desktop Entry]
            Type=Application
            Name=AgenticNetOS
            Comment=Agentic-Nets Desktop Lite — nets, schedules and MCP on your machine
            Exec=%s
            Icon=%s
            Terminal=false
            Categories=Development;
            """.formatted(launcher.toAbsolutePath(), icon.toAbsolutePath())
            + (autostart ? "X-GNOME-Autostart-enabled=true\n" : "");
    }

}
