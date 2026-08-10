package com.sailer.agenticos.desktop;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * AgenticNetOS Desktop — single-install launcher.
 *
 * Supervises vault(file) → blobstore → node → master → gateway → mcp(http) as child
 * processes on the bundled runtimes, serves the Studio GUI on :4200 with a
 * built-in gateway reverse proxy, and lives in the system tray.
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        // Tray-only on macOS: no Dock icon. Must be set before AWT initializes.
        System.setProperty("apple.awt.UIElement", "true");

        Path appDir = resolveAppDir();
        DesktopConfig config = new DesktopConfig(appDir);
        Supervisor supervisor = new Supervisor(buildSpecs(config), config.logsDir(),
            Long.parseLong(config.setting("logs.console.maxMb", "16")) * 1024 * 1024);
        GuiServer guiServer = new GuiServer(config.guiDir(), DesktopConfig.GATEWAY_PORT, () -> {
            try {
                return config.adminSecret();
            } catch (java.io.IOException e) {
                throw new java.io.UncheckedIOException(e);
            }
        });

        Runnable quit = () -> {
            System.out.println("[desktop] shutting down");
            supervisor.stopAll();
            guiServer.stop();
            System.exit(0);
        };
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            supervisor.stopAll();
            guiServer.stop();
        }));

        guiServer.enableDesktopApi(config, () -> {
            try {
                // fresh config + spec so the restart carries the just-saved settings
                DesktopConfig fresh = new DesktopConfig(appDir);
                ServiceSpec freshMaster = buildSpecs(fresh).stream()
                    .filter(s -> s.name().equals("master")).findFirst().orElseThrow();
                supervisor.restartOne(freshMaster);
                System.out.println("[desktop] master restarted with new LLM settings");
            } catch (Exception e) {
                System.err.println("[desktop] master restart failed: " + e.getMessage());
            }
        });
        guiServer.start(config.bindAddress(), DesktopConfig.GUI_PORT);
        System.out.println("[desktop] Studio on http://localhost:" + DesktopConfig.GUI_PORT
            + " (profile " + DesktopConfig.PROFILE_NAME + ", app dir " + appDir
            + ", data dir " + config.dataDir() + ")");

        DesktopIntegration.installLinuxMenuEntry(config);
        TrayUi tray = new TrayUi(config, supervisor, guiServer, quit);
        boolean hasTray = tray.install();
        if (!hasTray) {
            System.out.println("[desktop] no system tray — running headless, Ctrl+C to stop");
        }
        UpdateChecker.start(config.version(), version -> {
            System.out.println("[desktop] update available: " + version
                + " — https://github.com/alexejsailer/agentic-nets/releases");
            tray.showUpdateAvailable(version);
        });

        Thread.ofVirtual().start(() -> {
            try {
                supervisor.startAll();
                System.out.println("[desktop] all services healthy");
                System.out.println("[desktop] MCP endpoint ready on loopback; connect it from the tray menu");
            } catch (Exception e) {
                System.err.println("[desktop] startup failed: " + e.getMessage());
            }
        });

        Thread.currentThread().join();
    }

    private static Path resolveAppDir() throws Exception {
        String override = System.getProperty("agenticos.desktop.app");
        if (override != null && !override.isBlank()) {
            return Path.of(override).toAbsolutePath();
        }
        File jar = new File(Main.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        return jar.getParentFile().toPath().toAbsolutePath();
    }

    private static List<ServiceSpec> buildSpecs(DesktopConfig config) {
        String bind = config.bindAddress();
        String logs = config.logsDir().toAbsolutePath().toString();
        List<ServiceSpec> specs = new ArrayList<>();

        specs.add(new ServiceSpec(
            "vault", "Vault (file store)",
            javaCommand(config, "vault", "agentic-net-vault.jar"),
            merge(baseEnv(bind, logs), Map.of(
                "VAULT_BACKEND", "file",
                "SERVER_PORT", String.valueOf(DesktopConfig.VAULT_PORT))),
            config.runDir("vault"),
            "http://127.0.0.1:" + DesktopConfig.VAULT_PORT + "/api/health/ping",
            60));

        // Blob store — NetHub publishes offload the package payload here, so it must be up
        // before master's template seeding runs. Single-node profile: port 8090, no cluster.
        specs.add(new ServiceSpec(
            "blobstore", "Blob store",
            javaCommand(config, "blobstore", "sa-blobstore.jar"),
            merge(baseEnv(bind, logs), Map.of(
                "SPRING_PROFILES_ACTIVE", "single",
                "SERVER_PORT", String.valueOf(DesktopConfig.BLOBSTORE_PORT),
                "SA_BLOBSTORE_STORAGE_PATH", config.blobsDir().toAbsolutePath().toString())),
            config.runDir("blobstore"),
            "http://127.0.0.1:" + DesktopConfig.BLOBSTORE_PORT + "/actuator/health",
            60));

        specs.add(new ServiceSpec(
            "node", "Node (data engine)",
            javaCommand(config, "node", "agentic-net-node.jar"),
            merge(baseEnv(bind, logs), Map.of(
                "SERVER_PORT", String.valueOf(DesktopConfig.NODE_PORT))),
            config.runDir("node"),
            "http://127.0.0.1:" + DesktopConfig.NODE_PORT + "/health",
            120));

        Map<String, String> masterEnv = merge(baseEnv(bind, logs), Map.of(
            "SERVER_PORT", String.valueOf(DesktopConfig.MASTER_PORT),
            "AGENTICOS_DESKTOP_PROFILE", DesktopConfig.PROFILE_NAME,
            "AGENTIC_NET_NODE_BASE_URL", "http://127.0.0.1:" + DesktopConfig.NODE_PORT + "/api",
            "AGENTICOS_VAULT_URL", "http://127.0.0.1:" + DesktopConfig.VAULT_PORT,
            "BLOBSTORE_BASE_URL", "http://127.0.0.1:" + DesktopConfig.BLOBSTORE_PORT,
            "AGENTICOS_REGISTRY_ENABLED", "false",
            "AGENTICOS_KNOWLEDGE_SEED_BLOBS_ENABLED", "false",
            "AGENTICNET_USAGE_PERSIST_FILE",
                config.runDir("master").resolve("usage-fires.jsonl").toAbsolutePath().toString()));
        masterEnv.putAll(llmEnv(config));
        if (config.settingFlag("docker.enabled")) {
            masterEnv.put("AGENTICOS_DOCKER_ENABLED", "true");
            masterEnv.put("AGENTICOS_DOCKER_PUBLISH_HOST_PORT", "true");
        } else {
            masterEnv.put("AGENTICOS_DOCKER_ENABLED", "false");
        }
        specs.add(new ServiceSpec(
            "master", "Master (orchestration)",
            javaCommand(config, "master", "agentic-net-master.jar"),
            masterEnv,
            config.runDir("master"),
            "http://127.0.0.1:" + DesktopConfig.MASTER_PORT + "/actuator/health",
            90));

        specs.add(new ServiceSpec(
            "gateway", "Gateway (API)",
            javaCommand(config, "gateway", "agentic-net-gateway.jar"),
            merge(baseEnv(bind, logs), Map.of(
                "SERVER_PORT", String.valueOf(DesktopConfig.GATEWAY_PORT),
                "GATEWAY_JWT_KEY_DIR", config.gatewayJwtDir().toAbsolutePath().toString(),
                // single-user loopback: day-long Studio sessions instead of hourly re-login
                "GATEWAY_TOKEN_TTL", "86400",
                "MASTER_URL", "http://127.0.0.1:" + DesktopConfig.MASTER_PORT,
                "NODE_URL", "http://127.0.0.1:" + DesktopConfig.NODE_PORT,
                "VAULT_URL", "http://127.0.0.1:" + DesktopConfig.VAULT_PORT)),
            config.runDir("gateway"),
            "http://127.0.0.1:" + DesktopConfig.GATEWAY_PORT + "/api/health/ping",
            60));

        // direct-mode executor (same trust domain on loopback; blank client id disables auth)
        Map<String, String> executorEnv = merge(baseEnv(bind, logs), executorEnv());
        specs.add(new ServiceSpec(
            "executor", "Executor (commands)",
            javaCommand(config, "executor", "agentic-net-executor.jar"),
            executorEnv,
            config.runDir("executor"),
            "http://127.0.0.1:" + DesktopConfig.EXECUTOR_PORT + "/actuator/health",
            60));

        Map<String, String> mcpEnv = new LinkedHashMap<>();
        mcpEnv.put("AGENTICOS_MCP_TRANSPORT", "http");
        mcpEnv.put("AGENTICOS_MCP_HTTP_PORT", String.valueOf(DesktopConfig.MCP_PORT));
        mcpEnv.put("AGENTICOS_MCP_HTTP_HOST", bind);
        mcpEnv.put("AGENTICOS_MCP_HTTP_TOKEN", config.mcpToken());
        mcpEnv.put("AGENTICOS_NATIVE_TOOLS",
            System.getenv().getOrDefault("AGENTICOS_NATIVE_TOOLS", "curated"));
        mcpEnv.put("AGENTICOS_GATEWAY_URL", "http://127.0.0.1:" + DesktopConfig.GATEWAY_PORT);
        mcpEnv.put("AGENTICOS_GATEWAY_SECRET_FILE", config.adminSecretFile().toAbsolutePath().toString());
        mcpEnv.put("AGENTICOS_MODELS", config.setting("mcp.models", "default"));
        mcpEnv.put("AGENTICOS_SESSION", config.setting("mcp.session", "desktop"));
        mcpEnv.put("AGENTICOS_NODE_HOST", "127.0.0.1:" + DesktopConfig.NODE_PORT);
        specs.add(new ServiceSpec(
            "mcp", "MCP endpoint",
            List.of(config.nodeBinary().toAbsolutePath().toString(),
                config.mcpDir().resolve("dist").resolve("bin").resolve("agenticnets-mcp.js")
                    .toAbsolutePath().toString()),
            mcpEnv,
            config.mcpDir(),
            "http://127.0.0.1:" + DesktopConfig.MCP_PORT + "/health",
            30));

        return specs;
    }

    static Map<String, String> llmEnv(DesktopConfig config) {
        Map<String, String> env = new LinkedHashMap<>();
        String provider = config.setting("llm.provider", "disabled").toLowerCase(Locale.ROOT);
        String anthropicKey = config.setting("anthropic.api.key", "");
        if ("claude".equals(provider) && anthropicKey.isEmpty()) {
            System.err.println("[desktop] llm.provider=claude but anthropic.api.key is empty — server-side LLM disabled");
            provider = "disabled";
        }
        env.put("LLM_PROVIDER", provider);
        if ("disabled".equals(provider)) {
            return env;
        }
        env.put("OLLAMA_BASE_URL", config.setting("ollama.base.url", "http://127.0.0.1:11434"));
        env.put("OLLAMA_MODEL", config.setting("ollama.model", "glm-5.2:cloud"));
        putIfConfigured(env, config, "ollama.low.model", "OLLAMA_LOW_MODEL");
        putIfConfigured(env, config, "ollama.medium.model", "OLLAMA_MEDIUM_MODEL");
        putIfConfigured(env, config, "ollama.high.model", "OLLAMA_HIGH_MODEL");
        putIfConfigured(env, config, "ollama.thinking.model", "OLLAMA_THINKING_MODEL");
        if (!anthropicKey.isEmpty()) {
            env.put("ANTHROPIC_API_KEY", anthropicKey);
        }
        return env;
    }

    /** Desktop's one local executor is eligible for every model and activates new assignments fast. */
    static Map<String, String> executorEnv() {
        return Map.of(
            "SERVER_PORT", String.valueOf(DesktopConfig.EXECUTOR_PORT),
            "EXECUTOR_UPSTREAM_URL", "http://127.0.0.1:" + DesktopConfig.MASTER_PORT,
            "EXECUTOR_AUTH_CLIENT_ID", "",
            "EXECUTOR_ID", "agentic-net-executor-default",
            "EXECUTOR_MODELS", "*",
            "EXECUTOR_DISCOVERY_INTERVAL_MS", "5000");
    }

    private static void putIfConfigured(Map<String, String> env, DesktopConfig config,
                                        String settingKey, String envKey) {
        String value = config.setting(settingKey, "");
        if (!value.isEmpty()) {
            env.put(envKey, value);
        }
    }

    private static Map<String, String> baseEnv(String bind, String logs) {
        Map<String, String> env = new LinkedHashMap<>();
        env.put("SERVER_ADDRESS", bind);
        env.put("LOG_PATH", logs);
        env.put("OTEL_SDK_DISABLED", "true");
        String path = enrichedPath(System.getenv("PATH"));
        if (path != null) {
            env.put("PATH", path);
        }
        return env;
    }

    /**
     * A tray/Finder-launched app inherits launchd's minimal PATH ({@code /usr/bin:/bin:...})
     * — none of the places user CLIs live. Master's {@code llmMode:"bash"} personas and
     * executor command lanes then fail with exit 127 for {@code claude}/{@code codex} that
     * work fine in every terminal, which reads as a platform bug rather than an environment
     * accident. Append the standard user bin dirs (existing ones only) so children see the
     * CLIs the user actually installed. POSIX only — Windows GUI processes inherit the user
     * PATH that CLI installers already extend.
     */
    static String enrichedPath(String current) {
        if (File.separatorChar == '\\') {
            return null; // keep the inherited Windows PATH untouched
        }
        String home = System.getProperty("user.home", "");
        List<String> candidates = List.of(
            home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin");
        StringBuilder path = new StringBuilder(current == null ? "" : current);
        for (String dir : candidates) {
            boolean present = (":" + path + ":").contains(":" + dir + ":");
            if (!present && Files.isDirectory(Path.of(dir))) {
                if (path.length() > 0) {
                    path.append(':');
                }
                path.append(dir);
            }
        }
        return path.length() == 0 ? null : path.toString();
    }

    private static Map<String, String> merge(Map<String, String> base, Map<String, String> extra) {
        Map<String, String> merged = new LinkedHashMap<>(base);
        merged.putAll(extra);
        return merged;
    }

    private static List<String> javaCommand(DesktopConfig config, String service, String jarName) {
        List<String> command = new ArrayList<>();
        command.add(config.javaBinary().toAbsolutePath().toString());
        command.add("-Xmx" + config.setting("heap." + service, "512m"));
        command.add("-jar");
        command.add(config.servicesDir().resolve(jarName).toAbsolutePath().toString());
        return command;
    }
}
