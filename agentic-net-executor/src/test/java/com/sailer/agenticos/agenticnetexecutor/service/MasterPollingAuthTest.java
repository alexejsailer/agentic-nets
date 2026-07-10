package com.sailer.agenticos.agenticnetexecutor.service;

import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStore;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pins the gateway-auth contract of {@link MasterPollingService}: with a client id and a secret
 * SOURCE configured (inline value or mounted secret file), every upstream call first acquires a
 * client-credentials JWT and sends it as a Bearer header. The secret file is read lazily so a
 * gateway-generated {@code executor-secret} that appears after boot is picked up without restart —
 * that is exactly the fresh-`docker compose up` ordering (gateway writes the file while the
 * executor is already polling).
 */
class MasterPollingAuthTest {

    @TempDir
    Path tempDir;

    private MockWebServer mockGateway;

    @BeforeEach
    void setUp() throws Exception {
        mockGateway = new MockWebServer();
        mockGateway.start();
    }

    @AfterEach
    void tearDown() throws Exception {
        if (mockGateway != null) {
            mockGateway.shutdown();
        }
    }

    private MasterPollingService service(String clientId, String secret, String secretFile) {
        String baseUrl = mockGateway.url("/").toString().replaceAll("/$", "");
        return new MasterPollingService(
                baseUrl, "test-executor-auth", clientId, secret, secretFile, "*",
                new TransitionStore(), null);
    }

    private void enqueueToken() {
        mockGateway.enqueue(new MockResponse()
                .setResponseCode(200)
                .addHeader("Content-Type", "application/json")
                .setBody("{\"access_token\":\"jwt-from-test\",\"token_type\":\"Bearer\",\"expires_in\":3600}"));
    }

    private void enqueueDiscover() {
        mockGateway.enqueue(new MockResponse()
                .setResponseCode(200)
                .addHeader("Content-Type", "application/json")
                .setBody("{\"executorId\":\"test-executor-auth\",\"assignments\":[]}"));
    }

    @Test
    void secretFile_isUsedForTokenFetch_andBearerIsAttached() throws Exception {
        Path secretFile = tempDir.resolve("executor-secret");
        Files.writeString(secretFile, "file-secret-value\n");

        MasterPollingService svc = service("agenticos-executor", "", secretFile.toString());
        enqueueToken();
        enqueueDiscover();

        svc.discoverAssignments();

        RecordedRequest tokenReq = mockGateway.takeRequest(5, TimeUnit.SECONDS);
        assertThat(tokenReq).isNotNull();
        assertThat(tokenReq.getPath()).isEqualTo("/oauth2/token");
        String form = tokenReq.getBody().readUtf8();
        assertThat(form).contains("client_id=agenticos-executor");
        assertThat(form).contains("client_secret=file-secret-value"); // trailing newline stripped

        RecordedRequest discoverReq = mockGateway.takeRequest(5, TimeUnit.SECONDS);
        assertThat(discoverReq).isNotNull();
        assertThat(discoverReq.getPath()).startsWith("/api/transitions/discover");
        assertThat(discoverReq.getHeader("Authorization")).isEqualTo("Bearer jwt-from-test");
    }

    @Test
    void inlineSecret_takesPrecedenceOverFile() throws Exception {
        Path secretFile = tempDir.resolve("executor-secret");
        Files.writeString(secretFile, "file-secret-value");

        MasterPollingService svc = service("agenticos-executor", "inline-secret", secretFile.toString());
        enqueueToken();
        enqueueDiscover();

        svc.discoverAssignments();

        RecordedRequest tokenReq = mockGateway.takeRequest(5, TimeUnit.SECONDS);
        assertThat(tokenReq).isNotNull();
        assertThat(tokenReq.getBody().readUtf8()).contains("client_secret=inline-secret");
    }

    @Test
    void missingSecretFile_failsSoftly_thenRecoversOnceFileAppears() throws Exception {
        Path secretFile = tempDir.resolve("not-yet-written");

        MasterPollingService svc = service("agenticos-executor", "", secretFile.toString());

        // First cycle: no secret available — the token fetch fails locally, no request reaches
        // the gateway, and the error is swallowed (poll loop keeps running).
        svc.discoverAssignments();
        assertThat(mockGateway.takeRequest(1, TimeUnit.SECONDS)).isNull();

        // Gateway (concurrently) generates the secret file — next cycle must pick it up.
        Files.writeString(secretFile, "late-secret");
        enqueueToken();
        enqueueDiscover();

        svc.discoverAssignments();

        RecordedRequest tokenReq = mockGateway.takeRequest(5, TimeUnit.SECONDS);
        assertThat(tokenReq).isNotNull();
        assertThat(tokenReq.getBody().readUtf8()).contains("client_secret=late-secret");
    }

    @Test
    void directMode_noClientId_sendsNoAuthorizationHeader() throws Exception {
        MasterPollingService svc = service("", "", "");
        enqueueDiscover();

        svc.discoverAssignments();

        RecordedRequest discoverReq = mockGateway.takeRequest(5, TimeUnit.SECONDS);
        assertThat(discoverReq).isNotNull();
        assertThat(discoverReq.getPath()).startsWith("/api/transitions/discover");
        assertThat(discoverReq.getHeader("Authorization")).isNull();
    }
}
