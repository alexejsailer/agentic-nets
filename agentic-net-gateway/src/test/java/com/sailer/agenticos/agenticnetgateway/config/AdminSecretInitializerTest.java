package com.sailer.agenticos.agenticnetgateway.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests for {@link AdminSecretInitializer} — bootstraps the gateway's OAuth2 admin/readonly secrets. This is a
 * security control: an operator who never configures a secret still gets a strong random one, and it must be
 * STABLE across restarts (regenerating it every boot would silently break every already-issued client) and
 * stored with owner-only permissions. These pin the generate / persist / load-from-file resolution order plus
 * the hex-strength and file-permission guarantees. Driven end-to-end against a {@code @TempDir} key directory.
 */
class AdminSecretInitializerTest {

    @TempDir
    Path keyDir;

    private GatewayProperties propsWithKeyDir() {
        GatewayProperties p = new GatewayProperties();
        p.setJwtKeyDir(keyDir.toString());
        return p;
    }

    @Test
    void generatesAndPersistsBothSecretsWhenNoneConfigured() throws Exception {
        GatewayProperties props = propsWithKeyDir();
        new AdminSecretInitializer(props).initSecrets();

        Path adminFile = keyDir.resolve("admin-secret");
        Path readonlyFile = keyDir.resolve("readonly-secret");
        Path executorFile = keyDir.resolve("executor-secret");
        assertThat(adminFile).exists();
        assertThat(readonlyFile).exists();
        assertThat(executorFile).exists();

        // The generated secret is loaded back into the live properties so the app can use it immediately.
        assertThat(props.getClientSecret()).isEqualTo(Files.readString(adminFile).strip());
        assertThat(props.getReadonlyClientSecret()).isEqualTo(Files.readString(readonlyFile).strip());
        assertThat(props.getExecutorClientSecret()).isEqualTo(Files.readString(executorFile).strip());
        // ...and all three are distinct.
        assertThat(props.getClientSecret()).isNotEqualTo(props.getReadonlyClientSecret());
        assertThat(props.getExecutorClientSecret())
                .isNotEqualTo(props.getClientSecret())
                .isNotEqualTo(props.getReadonlyClientSecret());
    }

    @Test
    void generatedSecretIs64LowercaseHexChars() throws Exception {
        GatewayProperties props = propsWithKeyDir();
        new AdminSecretInitializer(props).initSecrets();
        assertThat(props.getClientSecret()).matches("^[0-9a-f]{64}$"); // 32 bytes of SecureRandom
    }

    @Test
    void aConfiguredSecretIsPersistedRatherThanRegenerated() throws Exception {
        GatewayProperties props = propsWithKeyDir();
        props.setClientSecret("operator-provided-secret");
        new AdminSecretInitializer(props).initSecrets();

        assertThat(Files.readString(keyDir.resolve("admin-secret")).strip()).isEqualTo("operator-provided-secret");
        assertThat(props.getClientSecret()).isEqualTo("operator-provided-secret");
    }

    @Test
    void anExistingSecretFileIsLoadedNotOverwritten() throws Exception {
        Files.writeString(keyDir.resolve("admin-secret"), "pre-existing-secret");
        GatewayProperties props = propsWithKeyDir(); // no configured secret

        new AdminSecretInitializer(props).initSecrets();

        assertThat(props.getClientSecret()).isEqualTo("pre-existing-secret");
        assertThat(Files.readString(keyDir.resolve("admin-secret")).strip()).isEqualTo("pre-existing-secret");
    }

    @Test
    void theGeneratedSecretIsStableAcrossRestarts() throws Exception {
        // First boot generates it; a second boot (fresh properties, same dir) must load the SAME secret,
        // not mint a new one — otherwise every previously-issued token would break.
        GatewayProperties first = propsWithKeyDir();
        new AdminSecretInitializer(first).initSecrets();
        String generated = first.getClientSecret();

        GatewayProperties second = propsWithKeyDir();
        new AdminSecretInitializer(second).initSecrets();

        assertThat(second.getClientSecret()).isEqualTo(generated);
    }

    @Test
    void secretFileIsOwnerReadWriteOnly() throws Exception {
        new AdminSecretInitializer(propsWithKeyDir()).initSecrets();
        Set<PosixFilePermission> perms = Files.getPosixFilePermissions(keyDir.resolve("admin-secret"));
        assertThat(perms).containsExactlyInAnyOrder(
                PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
    }
}
