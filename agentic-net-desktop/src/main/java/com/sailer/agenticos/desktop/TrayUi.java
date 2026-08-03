package com.sailer.agenticos.desktop;

import java.awt.CheckboxMenuItem;
import java.awt.Color;
import java.awt.Desktop;
import java.awt.Graphics2D;
import java.awt.MenuItem;
import java.awt.PopupMenu;
import java.awt.RenderingHints;
import java.awt.SystemTray;
import java.awt.Toolkit;
import java.awt.TrayIcon;
import java.awt.datatransfer.StringSelection;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.net.URI;
import java.util.Map;

/**
 * System-tray presence: status dot, per-service state, Open Studio, and the
 * one-click MCP connect actions. Falls back to headless (log-only) operation
 * when no tray is available.
 */
public final class TrayUi {

    private final DesktopConfig config;
    private final Supervisor supervisor;
    private final GuiServer guiServer;
    private final Runnable onQuit;
    private TrayIcon trayIcon;
    private PopupMenu menu;
    private MenuItem updateItem;
    private volatile String pendingUpdate;

    public TrayUi(DesktopConfig config, Supervisor supervisor, GuiServer guiServer, Runnable onQuit) {
        this.config = config;
        this.supervisor = supervisor;
        this.guiServer = guiServer;
        this.onQuit = onQuit;
    }

    public boolean install() {
        try {
            // isHeadless first: on a Linux server without X libs, touching SystemTray
            // throws UnsatisfiedLinkError (an Error) — hence catch Throwable below too
            if (java.awt.GraphicsEnvironment.isHeadless() || !SystemTray.isSupported()) {
                return false;
            }
            menu = buildMenu();
            trayIcon = new TrayIcon(trayImage(false, true), "AgenticNetOS", menu);
            trayIcon.setImageAutoSize(true);
            // Double-click (Windows/Linux) goes straight to Studio, signed in —
            // the common case, and what people expect from a tray app.
            trayIcon.addActionListener(e -> {
                try {
                    Desktop.getDesktop().browse(URI.create("http://localhost:"
                        + DesktopConfig.GUI_PORT + guiServer.createLoginPath()));
                } catch (Exception ex) {
                    notifyError("Could not open Studio", String.valueOf(ex.getMessage()));
                }
            });
            SystemTray.getSystemTray().add(trayIcon);
            supervisor.onStatusChange((name, status) -> refresh());
            refresh();
            return true;
        } catch (Throwable e) {
            System.err.println("[desktop] tray unavailable: " + e.getMessage());
            return false;
        }
    }

    private PopupMenu buildMenu() {
        PopupMenu popup = new PopupMenu();

        MenuItem title = new MenuItem("AgenticNetOS Desktop Lite " + config.version());
        title.setEnabled(false);
        popup.add(title);
        popup.addSeparator();

        // one status line per service, refreshed in place
        for (String display : supervisor.statuses().keySet()) {
            CheckboxMenuItem item = new CheckboxMenuItem(display + " — starting");
            item.setEnabled(false);
            popup.add(item);
        }
        popup.addSeparator();

        // auto-login: single-use nonce link; the admin secret stays server-side
        popup.add(action("Open Studio", () ->
            Desktop.getDesktop().browse(URI.create("http://localhost:" + DesktopConfig.GUI_PORT
                + guiServer.createLoginPath()))));
        popup.add(action("Open Protocol", () ->
            Desktop.getDesktop().browse(URI.create("http://localhost:" + DesktopConfig.GUI_PORT
                + guiServer.createLoginPath() + "&to=%2F%23%2Fprotocol"))));
        popup.add(action("LLM Settings", () ->
            Desktop.getDesktop().browse(URI.create("http://localhost:" + DesktopConfig.GUI_PORT
                + guiServer.createLoginPath() + "&to=%2F%23%2Fsettings"))));
        popup.addSeparator();

        popup.add(action("Connect Claude Code (copy command)", () -> {
            copyToClipboard(claudeMcpAddCommand());
            notifyInfo("Command copied", "Paste into a terminal to add the AgenticNets MCP server.");
        }));
        popup.add(action("Connect Codex (copy config)", () -> {
            copyToClipboard(codexMcpConfig());
            notifyInfo("Codex config copied", "Paste into ~/.codex/config.toml, then restart Codex.");
        }));
        popup.add(action("Copy MCP URL + Token", () -> {
            copyToClipboard("http://127.0.0.1:" + DesktopConfig.MCP_PORT + "/mcp\nBearer " + config.mcpToken());
            notifyInfo("MCP endpoint copied", "URL on line 1, Authorization value on line 2.");
        }));
        // Sits with the connect actions on purpose: this is where a first-time user
        // lands, and the manual answers the question they have next ("now what?").
        popup.add(action("Manual (Start Here)", () ->
            Desktop.getDesktop().browse(URI.create(manualUrl()))));
        popup.addSeparator();

        CheckboxMenuItem startAtLogin = new CheckboxMenuItem("Start at Login",
            DesktopIntegration.isStartAtLoginEnabled());
        startAtLogin.addItemListener(e -> {
            try {
                startAtLogin.setState(DesktopIntegration.setStartAtLogin(startAtLogin.getState(), config));
            } catch (Exception ex) {
                startAtLogin.setState(DesktopIntegration.isStartAtLoginEnabled());
                notifyError("Start at Login failed", String.valueOf(ex.getMessage()));
            }
        });
        popup.add(startAtLogin);

        updateItem = action("Check for Updates", this::onUpdateAction);
        popup.add(updateItem);
        popup.add(action("Open Logs Folder", () -> Desktop.getDesktop().open(config.logsDir().toFile())));
        popup.add(action("Restart Services", () -> Thread.ofVirtual().start(() -> {
            try {
                supervisor.restartAll();
            } catch (Exception e) {
                notifyError("Restart failed", String.valueOf(e.getMessage()));
            }
        })));
        popup.addSeparator();

        popup.add(action("Quit AgenticNetOS", onQuit::run));
        return popup;
    }

    /** Called by UpdateChecker when a newer release exists. */
    public void showUpdateAvailable(String version) {
        pendingUpdate = version;
        boolean autoApply = SelfUpdater.isMac() && config.appBundle() != null;
        if (updateItem != null) {
            updateItem.setLabel(autoApply
                ? "Install update " + version + " (restarts app)"
                : "Download update " + version);
        }
        notifyInfo("Update available", "AgenticNetOS " + version + " is out — "
            + (autoApply ? "install it from the tray menu." : "download it from the tray menu."));
    }

    /** No update known: open the Releases page. Update known: download, verify, apply. */
    private void onUpdateAction() throws IOException {
        String version = pendingUpdate;
        if (version == null) {
            Desktop.getDesktop().browse(URI.create("https://github.com/alexejsailer/agentic-nets/releases"));
            return;
        }
        Thread.ofVirtual().start(() -> {
            try {
                notifyInfo("Downloading update", "AgenticNetOS " + version + " …");
                java.nio.file.Path pkg = SelfUpdater.downloadAndVerify(version, config.updatesDir());
                java.nio.file.Path bundle = config.appBundle();
                if (SelfUpdater.isMac() && bundle != null) {
                    notifyInfo("Installing update", "Services stop, the app replaces itself and relaunches.");
                    // Sweep BEFORE the applier is spawned: the applier is itself a java
                    // process from the install runtime, and the sweep must not kill it.
                    SelfUpdater.stopAndSweep(supervisor::stopAll, config.installRoot(), config.runRoot());
                    SelfUpdater.applyOnMacAndRestart(pkg, bundle, config.updatesDir(), onQuit);
                } else if (SelfUpdater.isWindows()) {
                    notifyInfo("Installing update",
                        "Services stop first, then the installer starts; relaunch when it finishes.");
                    SelfUpdater.launchWindowsInstallerAndQuit(
                        pkg, config.installRoot(), config.runRoot(), supervisor::stopAll, onQuit);
                } else {
                    copyToClipboard(SelfUpdater.installCommand(pkg));
                    notifyInfo("Update downloaded and verified",
                        pkg.getFileName() + " — install command copied to clipboard (root required).");
                }
            } catch (Exception e) {
                notifyError("Update failed", String.valueOf(e.getMessage()));
            }
        });
    }

    /**
     * No login nonce: the manual is documentation, not app state, so it stays
     * readable while the gateway is still starting or has failed to start.
     */
    String manualUrl() {
        return "http://localhost:" + DesktopConfig.GUI_PORT + "/manual";
    }

    public String claudeMcpAddCommand() {
        return "claude mcp add --transport http agenticnets http://127.0.0.1:" + DesktopConfig.MCP_PORT
            + "/mcp --header \"Authorization: Bearer " + config.mcpToken() + "\"";
    }

    /**
     * Codex CLI supports Streamable HTTP MCP servers with static HTTP headers in
     * config.toml. A snippet is more durable than an environment variable that
     * disappears with the shell used to run `codex mcp add`.
     */
    String codexMcpConfig() {
        return """
            [mcp_servers.agenticnets]
            url = "http://127.0.0.1:%d/mcp"
            http_headers = { Authorization = "Bearer %s" }
            """.formatted(DesktopConfig.MCP_PORT, config.mcpToken());
    }

    private void refresh() {
        if (trayIcon == null) {
            return;
        }
        Map<String, Supervisor.Status> statuses = supervisor.statuses();
        int index = 2; // 0 = title, 1 = separator
        boolean anyBad = false;
        boolean anyPending = false;
        for (Map.Entry<String, Supervisor.Status> entry : statuses.entrySet()) {
            Supervisor.Status status = entry.getValue();
            anyBad |= status == Supervisor.Status.CRASHED || status == Supervisor.Status.FAILED;
            anyPending |= status == Supervisor.Status.PENDING || status == Supervisor.Status.STARTING;
            if (index < menu.getItemCount() && menu.getItem(index) instanceof CheckboxMenuItem item) {
                item.setLabel(entry.getKey() + " — " + status.name().toLowerCase());
                item.setState(status == Supervisor.Status.RUNNING);
            }
            index++;
        }
        trayIcon.setImage(trayImage(anyBad, anyPending));
        trayIcon.setToolTip("AgenticNetOS — " + (anyBad ? "attention needed" : anyPending ? "starting" : "running"));
    }

    /**
     * The brand glyph, matching the favicon: three connected places — left and
     * right nodes with a raised middle node, two arcs through it and a fainter
     * bottom arc closing the triangle. Monochrome like native menu bar symbols
     * (white/black per theme). Starting = dimmed; attention = small red badge.
     */
    static BufferedImage trayImage(boolean attention, boolean starting) {
        int size = 44;
        BufferedImage image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        Color fg = glyphColor();
        float base = starting ? 0.45f : 1f;
        g.setComposite(java.awt.AlphaComposite.SrcOver.derive(base));

        // favicon geometry, spread wide so the three places stay distinct at 16-22px
        g.setColor(fg);
        g.setStroke(new java.awt.BasicStroke(2.6f, java.awt.BasicStroke.CAP_ROUND, java.awt.BasicStroke.JOIN_ROUND));
        g.draw(new java.awt.geom.QuadCurve2D.Float(9f, 26f, 14.5f, 17f, 22f, 14f));
        g.draw(new java.awt.geom.QuadCurve2D.Float(22f, 14f, 29.5f, 17f, 35f, 26f));
        g.setComposite(java.awt.AlphaComposite.SrcOver.derive(base * 0.55f));
        g.setStroke(new java.awt.BasicStroke(2f, java.awt.BasicStroke.CAP_ROUND, java.awt.BasicStroke.JOIN_ROUND));
        g.draw(new java.awt.geom.QuadCurve2D.Float(9f, 26f, 22f, 32f, 35f, 26f));

        g.setComposite(java.awt.AlphaComposite.SrcOver.derive(base));
        g.fill(new java.awt.geom.Ellipse2D.Float(9 - 4.5f, 26 - 4.5f, 9f, 9f));    // left place
        g.fill(new java.awt.geom.Ellipse2D.Float(22 - 5.5f, 14 - 5.5f, 11f, 11f)); // middle place (larger, raised)
        g.fill(new java.awt.geom.Ellipse2D.Float(35 - 4.5f, 26 - 4.5f, 9f, 9f));   // right place

        if (attention) {
            g.setComposite(java.awt.AlphaComposite.SrcOver);
            g.setColor(new Color(0xE0443A));
            g.fillOval(size - 15, size - 15, 13, 13);
        }
        g.dispose();
        return image;
    }

    /** White glyph on dark menu bars/taskbars, black on light ones. */
    private static Color glyphColor() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("mac")) {
            try {
                Process p = new ProcessBuilder("defaults", "read", "-g", "AppleInterfaceStyle").start();
                return p.waitFor() == 0 ? Color.WHITE : Color.BLACK; // exits non-zero in light mode
            } catch (Exception e) {
                return Color.BLACK;
            }
        }
        if (os.contains("win")) {
            try {
                Process p = new ProcessBuilder("reg", "query",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                    "/v", "SystemUsesLightTheme").start();
                String out = new String(p.getInputStream().readAllBytes());
                p.waitFor();
                return out.contains("0x1") ? Color.BLACK : Color.WHITE;
            } catch (Exception e) {
                return Color.WHITE;
            }
        }
        return Color.WHITE; // Linux panels are dark by default
    }

    private MenuItem action(String label, ThrowingRunnable runnable) {
        MenuItem item = new MenuItem(label);
        item.addActionListener(e -> {
            try {
                runnable.run();
            } catch (Exception ex) {
                notifyError(label + " failed", String.valueOf(ex.getMessage()));
            }
        });
        return item;
    }

    private void copyToClipboard(String text) {
        Toolkit.getDefaultToolkit().getSystemClipboard()
            .setContents(new StringSelection(text), null);
    }

    private void notifyInfo(String title, String body) {
        if (trayIcon != null) {
            trayIcon.displayMessage(title, body, TrayIcon.MessageType.INFO);
        }
    }

    private void notifyError(String title, String body) {
        if (trayIcon != null) {
            trayIcon.displayMessage(title, body, TrayIcon.MessageType.ERROR);
        }
        System.err.println("[desktop] " + title + ": " + body);
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws IOException;
    }
}
