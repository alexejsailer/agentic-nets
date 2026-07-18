package com.sailer.agenticos.agenticnetexecutor.transition.runtime;

import com.sailer.agenticos.agenticnetexecutor.transition.TransitionDefinition;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionInscription;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStatus;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStore;
import com.sailer.agenticos.agenticnetexecutor.transition.service.ConsumptionService;
import com.sailer.agenticos.agenticnetexecutor.transition.service.EmissionService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Pins the credential-refresh fix: the master re-resolves vault credentials on EVERY poll and
 * ships them on the FIRE / FIRE_ONCE command, but the executor used to ignore them and fall back
 * to the DEPLOY-time snapshot in the {@link TransitionStore}. A credential set (or rotated in the
 * vault) after deployment therefore never reached the command env until a redeploy — observed
 * live as a fire_once running with an empty {@code $MEMOS_TOKEN} and getting a 401 while the
 * post-restart scheduled fire authenticated fine.
 */
class TransitionOrchestratorCredentialRefreshTest {

    private TransitionStore store;
    private TransitionActionExecutor actionExecutor;
    private TransitionOrchestrator orchestrator;

    private final CountDownLatch executed = new CountDownLatch(1);
    private final AtomicReference<TransitionContext> capturedContext = new AtomicReference<>();

    @BeforeEach
    void setUp() {
        store = new TransitionStore();
        actionExecutor = mock(TransitionActionExecutor.class);
        when(actionExecutor.execute(any(), any(), any())).thenAnswer(invocation -> {
            capturedContext.set(invocation.getArgument(2));
            executed.countDown();
            return ActionResult.success(Map.of(), Map.of());
        });
        orchestrator = new TransitionOrchestrator(
                store,
                mock(EmissionService.class),
                mock(ConsumptionService.class),
                actionExecutor,
                new SimpleMeterRegistry());
    }

    private void registerCommandDefinition(Map<String, Object> deployTimeCredentials) {
        TransitionInscription.Preset preset = new TransitionInscription.Preset(
                "p-in", "m1@localhost:8080", "FROM $ LIMIT 1",
                null, false, null, null, null, null, null);
        TransitionInscription inscription = new TransitionInscription(
                "t1", "command",
                Map.of("input", preset), null,
                new TransitionInscription.Action.CommandAction("input", null, null, null, null, null),
                List.of(),
                null, null, null, null);
        store.register(TransitionDefinition.builder()
                .modelId("m1")
                .transitionId("t1")
                .inscription(inscription)
                .status(TransitionStatus.RUNNING)
                .credentials(deployTimeCredentials)
                .build());
    }

    private Map<String, List<Map<String, Object>>> boundTokens() {
        return Map.of("input", List.of(Map.of(
                "_meta", Map.of("id", "tok-1", "name", "cfg", "parentId", "place-1", "type", "Leaf"),
                "data", Map.of("k", "v"))));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> credentialsSeenByAction() throws InterruptedException {
        assertThat(executed.await(5, TimeUnit.SECONDS)).as("action executed within 5s").isTrue();
        TransitionContext ctx = capturedContext.get();
        assertThat(ctx).isNotNull();
        return (Map<String, Object>) ctx.attribute("credentials");
    }

    @Test
    void fireOnceUsesTheCredentialsShippedOnThePollCommand_notTheDeploySnapshot() throws Exception {
        // Deployed BEFORE any credential existed — the exact live-failure shape.
        registerCommandDefinition(null);

        orchestrator.executeWithBoundTokens("m1", "t1", boundTokens(), true,
                Map.of("MEMOS_TOKEN", "fresh-from-vault"));

        assertThat(credentialsSeenByAction()).containsEntry("MEMOS_TOKEN", "fresh-from-vault");
    }

    @Test
    void fireRefreshesRotatedCredentials_pollCommandWinsOverStaleSnapshot() throws Exception {
        registerCommandDefinition(Map.of("MEMOS_TOKEN", "stale-deploy-time-secret"));

        orchestrator.executeWithBoundTokens("m1", "t1", boundTokens(), false,
                Map.of("MEMOS_TOKEN", "rotated-secret"));

        assertThat(credentialsSeenByAction()).containsEntry("MEMOS_TOKEN", "rotated-secret");
    }

    @Test
    void withoutShippedCredentialsTheDeploySnapshotStillApplies() throws Exception {
        // Back-compat: an older master that ships no credentials on the command
        // must not lose the deploy-time credentials.
        registerCommandDefinition(Map.of("MEMOS_TOKEN", "deploy-time-secret"));

        orchestrator.executeWithBoundTokens("m1", "t1", boundTokens(), false, null);

        assertThat(credentialsSeenByAction()).containsEntry("MEMOS_TOKEN", "deploy-time-secret");
    }
}
