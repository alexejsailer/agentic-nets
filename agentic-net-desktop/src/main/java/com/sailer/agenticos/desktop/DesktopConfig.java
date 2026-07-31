package com.sailer.agenticos.desktop;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Properties;

/**
 * Filesystem layout + user settings for the desktop bundle.
 *
 * App dir (read-only, assembled by build-desktop.sh):
 *   services/*.jar   gui/   mcp/{package.json,node_modules,dist}   node-runtime/bin/node
 *
 * Data dir (~/.agenticos — shared with native dev so existing models keep working):
 *   desktop/desktop.properties   desktop/mcp-token   desktop/gateway/jwt/
 *   desktop/logs/   desktop/run/<service>/   vault/ (file credential store)
 */
public final class DesktopConfig {

    public static final String PROFILE_NAME = "desktop-lite";
    public static final int GUI_PORT = 4200;
    public static final int NODE_PORT = 8080;
    public static final int MASTER_PORT = 8082;
    public static final int GATEWAY_PORT = 8083;
    public static final int EXECUTOR_PORT = 8084;
    public static final int VAULT_PORT = 8085;
    public static final int MCP_PORT = 8091;

    private final Path appDir;
    private final Path dataDir;
    private final Path desktopDir;
    private final Properties settings = new Properties();

    public DesktopConfig(Path appDir) {
        this.appDir = appDir;
        this.dataDir = Path.of(System.getProperty("user.home"), ".agenticos");
        this.desktopDir = dataDir.resolve("desktop");
        try {
            Files.createDirectories(desktopDir);
            restrictDirectoryPermissions(desktopDir);
            Files.createDirectories(logsDir());
            restrictDirectoryPermissions(logsDir());
            Files.createDirectories(gatewayJwtDir());
            restrictDirectoryPermissions(gatewayJwtDir());
            loadOrCreateSettings();
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to initialize " + desktopDir, e);
        }
    }

    private void loadOrCreateSettings() throws IOException {
        Path file = desktopDir.resolve("desktop.properties");
        if (!Files.exists(file)) {
            String template = """
                # AgenticNetOS Desktop settings. Edit and use the tray menu "Restart Services".

                # Desktop Lite is MCP-first: the connected client supplies the intelligence.
                # The master remains the deterministic net/schedule runtime but consumes no model.
                # Optional advanced values: ollama, claude (needs anthropic.api.key).
                llm.provider=disabled
                ollama.base.url=http://127.0.0.1:11434
                ollama.model=glm-5.2:cloud
                # Optional per-tier model routing (blank = master defaults)
                ollama.low.model=
                ollama.medium.model=
                ollama.high.model=
                ollama.thinking.model=
                anthropic.api.key=

                # Model allowlist for the MCP endpoint (comma-separated, first = default)
                mcp.models=default
                mcp.session=desktop

                # Docker-backed tool execution (needs Docker Desktop). Off by default.
                docker.enabled=false

                # Child JVM heaps
                heap.node=768m
                heap.master=512m
                heap.gateway=256m
                heap.vault=256m
                heap.executor=256m
                """;
            Files.writeString(file, template);
        }
        restrictFilePermissions(file);
        try (InputStream in = Files.newInputStream(file)) {
            settings.load(in);
        }
    }

    /**
     * Rewrites keys in desktop.properties in place (comments and order are
     * preserved — Properties.store would destroy them) and updates memory.
     */
    public synchronized void updateSettings(java.util.Map<String, String> updates) throws IOException {
        Path file = desktopDir.resolve("desktop.properties");
        java.util.List<String> lines = new java.util.ArrayList<>(Files.readAllLines(file));
        java.util.Map<String, String> remaining = new java.util.LinkedHashMap<>(updates);
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i).strip();
            int eq = line.indexOf('=');
            if (line.startsWith("#") || eq < 0) {
                continue;
            }
            String key = line.substring(0, eq).strip();
            if (remaining.containsKey(key)) {
                lines.set(i, key + "=" + remaining.remove(key));
            }
        }
        remaining.forEach((k, v) -> lines.add(k + "=" + v));
        Files.write(file, lines);
        restrictFilePermissions(file);
        updates.forEach(settings::setProperty);
    }

    public String setting(String key, String fallback) {
        String value = settings.getProperty(key);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    public boolean settingFlag(String key) {
        return Boolean.parseBoolean(setting(key, "false"));
    }

    /** Desktop Lite is intentionally single-user and loopback-only. */
    public String bindAddress() {
        return "127.0.0.1";
    }

    public Path appDir() { return appDir; }
    public Path dataDir() { return dataDir; }
    public Path desktopDir() { return desktopDir; }
    public Path logsDir() { return desktopDir.resolve("logs"); }
    public Path runDir(String service) { return desktopDir.resolve("run").resolve(service); }
    public Path gatewayJwtDir() { return desktopDir.resolve("gateway").resolve("jwt"); }
    public Path adminSecretFile() { return gatewayJwtDir().resolve("admin-secret"); }
    public Path servicesDir() { return appDir.resolve("services"); }
    public Path guiDir() { return appDir.resolve("gui"); }
    public Path mcpDir() { return appDir.resolve("mcp"); }
    public Path updatesDir() { return desktopDir.resolve("update"); }

    /** The installed .app bundle to swap on self-update (macOS only), else null. */
    public Path appBundle() {
        Path contents = appDir.getParent();
        Path bundle = contents == null ? null : contents.getParent();
        return bundle != null && bundle.getFileName() != null
            && bundle.getFileName().toString().endsWith(".app") ? bundle : null;
    }

    /** The installed launcher binary (menu entries, login items), else null. */
    public Path launcherBinary() {
        Path bundle = appBundle();
        if (bundle != null) {
            return bundle.resolve("Contents").resolve("MacOS").resolve("AgenticNetOS");
        }
        // Linux jpackage layout: <root>/lib/app ← appDir, launcher at <root>/bin/AgenticNetOS
        Path lib = appDir.getParent();
        Path root = lib == null ? null : lib.getParent();
        Path bin = root == null ? null : root.resolve("bin").resolve("AgenticNetOS");
        return bin != null && Files.isExecutable(bin) ? bin : null;
    }

    public Path nodeBinary() {
        Path bundled = appDir.resolve("node-runtime").resolve("bin").resolve("node");
        if (Files.exists(bundled)) {
            return bundled;
        }
        Path bundledWin = appDir.resolve("node-runtime").resolve("node.exe");
        return Files.exists(bundledWin) ? bundledWin : Path.of("node");
    }

    public Path javaBinary() {
        return Path.of(System.getProperty("java.home"), "bin",
            System.getProperty("os.name", "").toLowerCase().contains("win") ? "java.exe" : "java");
    }

    /** Bearer token for the MCP HTTP endpoint — generated once, stored 0600. */
    public String mcpToken() {
        Path file = desktopDir.resolve("mcp-token");
        try {
            if (Files.exists(file)) {
                restrictFilePermissions(file);
                return Files.readString(file).trim();
            }
            byte[] bytes = new byte[24];
            new SecureRandom().nextBytes(bytes);
            String token = HexFormat.of().formatHex(bytes);
            Files.writeString(file, token);
            restrictFilePermissions(file);
            return token;
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read/create MCP token at " + file, e);
        }
    }

    public String adminSecret() throws IOException {
        return Files.readString(adminSecretFile()).trim();
    }

    public String version() {
        return System.getProperty("agenticos.desktop.version", "dev");
    }

    private static void restrictDirectoryPermissions(Path directory) {
        try {
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException | IOException ignored) {
            // Windows: user-profile ACLs remain the authority.
        }
    }

    private static void restrictFilePermissions(Path file) {
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException ignored) {
            // Windows: user-profile ACLs remain the authority.
        }
    }
}
