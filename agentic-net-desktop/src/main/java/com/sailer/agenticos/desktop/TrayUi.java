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
                    SelfUpdater.applyOnMacAndRestart(pkg, bundle, config.updatesDir(), onQuit);
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
     * The brand glyph: a Petri-net place (circle outline) holding two tokens,
     * monochrome like native menu bar symbols — white on a dark menu bar, black
     * on a light one. Starting = dimmed tokens; attention = small red badge.
     */
    private static BufferedImage trayImage(boolean attention, boolean starting) {
        int size = 44;
        BufferedImage image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(glyphColor());
        if (starting) {
            g.setComposite(java.awt.AlphaComposite.SrcOver.derive(0.45f));
        }
        g.setStroke(new java.awt.BasicStroke(3.5f));
        g.drawOval(4, 4, size - 9, size - 9);
        g.fillOval(11, 17, 9, 9);
        g.fillOval(24, 17, 9, 9);
        if (attention) {
            g.setComposite(java.awt.AlphaComposite.SrcOver);
            g.setColor(new Color(0xE0443A));
            g.fillOval(size - 15, size - 15, 13, 13);
        }
        g.dispose();
        return image;
    }

    /** White glyph on dark menu bars/panels, black on a light macOS menu bar. */
    private static Color glyphColor() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("mac")) {
            return Color.WHITE; // Linux/Windows trays are dark by default
        }
        try {
            Process p = new ProcessBuilder("defaults", "read", "-g", "AppleInterfaceStyle").start();
            boolean dark = p.waitFor() == 0; // exits non-zero in light mode
            return dark ? Color.WHITE : Color.BLACK;
        } catch (Exception e) {
            return Color.BLACK;
        }
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
