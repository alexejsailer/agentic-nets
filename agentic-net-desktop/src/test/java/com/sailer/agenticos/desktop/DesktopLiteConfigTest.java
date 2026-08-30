package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class DesktopLiteConfigTest {

    @TempDir
    Path tempDir;

    @Test
    void freshProfileIsLocalAndDoesNotRequireAServerSideLlm() throws Exception {
        String previousHome = System.getProperty("user.home");
        try {
            System.setProperty("user.home", tempDir.toString());
            DesktopConfig config = new DesktopConfig(tempDir.resolve("app"));

            assertEquals("desktop-lite", DesktopConfig.PROFILE_NAME);
            assertEquals("127.0.0.1", config.bindAddress());
            assertEquals("disabled", config.setting("llm.provider", "unexpected"));
            assertEquals(Map.of("LLM_PROVIDER", "disabled"), Main.llmEnv(config));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void legacyLanFlagCannotExposeInternalDesktopServices() throws Exception {
        String previousHome = System.getProperty("user.home");
        try {
            System.setProperty("user.home", tempDir.toString());
            Path desktopDir = tempDir.resolve(".agenticos/desktop");
            Files.createDirectories(desktopDir);
            Files.writeString(desktopDir.resolve("desktop.properties"), """
                llm.provider=disabled
                expose.lan=true
                """);

            DesktopConfig config = new DesktopConfig(tempDir.resolve("app"));

            assertEquals("127.0.0.1", config.bindAddress());
            assertFalse(config.settingFlag("docker.enabled"));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void providerSettingIsCaseInsensitive() throws Exception {
        String previousHome = System.getProperty("user.home");
        try {
            System.setProperty("user.home", tempDir.toString());
            Path desktopDir = tempDir.resolve(".agenticos/desktop");
            Files.createDirectories(desktopDir);
            Files.writeString(desktopDir.resolve("desktop.properties"), "llm.provider=DISABLED\n");

            DesktopConfig config = new DesktopConfig(tempDir.resolve("app"));

            assertEquals(Map.of("LLM_PROVIDER", "disabled"), Main.llmEnv(config));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void groupsFileAndNamedProviderSettingsArePassedToMaster() throws Exception {
        String previousHome = System.getProperty("user.home");
        try {
            System.setProperty("user.home", tempDir.toString());
            Path desktopDir = tempDir.resolve(".agenticos/desktop");
            Files.createDirectories(desktopDir);
            Files.writeString(desktopDir.resolve("desktop.properties"), """
                llm.provider=disabled
                llm.providers.glm4.type=ollama
                llm.providers.glm4.base-url=http://127.0.0.1:11434
                llm.providers.glm4.model=glm-4.6
                """);
            Files.writeString(tempDir.resolve(".agenticos/llm-groups.json"), """
                {"groups":{"local-fast":{"provider":"glm4","low":"glm-4.6"}}}
                """);

            DesktopConfig config = new DesktopConfig(tempDir.resolve("app"));
            Map<String, String> env = Main.llmEnv(config);

            assertEquals(config.llmGroupsFile().toAbsolutePath().toString(), env.get("LLM_GROUPS_FILE"));
            assertEquals("ollama", env.get("LLM_PROVIDERS_GLM4_TYPE"));
            assertEquals("http://127.0.0.1:11434", env.get("LLM_PROVIDERS_GLM4_BASE_URL"));
            assertEquals("glm-4.6", env.get("LLM_PROVIDERS_GLM4_MODEL"));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void bundledExecutorCanActivateCommandLanesInEveryModelQuickly() {
        Map<String, String> env = Main.executorEnv();

        assertEquals("agentic-net-executor-default", env.get("EXECUTOR_ID"));
        assertEquals("*", env.get("EXECUTOR_MODELS"));
        assertEquals("5000", env.get("EXECUTOR_DISCOVERY_INTERVAL_MS"));
    }
}
