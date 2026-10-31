package com.sailer.agenticos.agenticnetgateway.tenant;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The fence between two tenants, alice and bob, route family by route family: alice on her own
 * model passes, alice on bob's model (or the operator's) is refused, and so is any route the table
 * does not list.
 */
class TenantRoutePolicyTest {

    private static TenantRoutePolicy.Decision as(String tenant, String method, String path, String query, String body) {
        Map<String, String[]> q = new LinkedHashMap<>(TenantScopeEnforcementFilter.parseQuery(query));
        return TenantRoutePolicy.decide(tenant, null, new TenantRoutePolicy.Request(method, path, q,
                body == null ? null : body.getBytes(StandardCharsets.UTF_8)));
    }

    private static TenantRoutePolicy.Decision exec(String tenant, String executorId, String method, String path, String query, String body) {
        return TenantRoutePolicy.decide(tenant, executorId, new TenantRoutePolicy.Request(method, path,
                TenantScopeEnforcementFilter.parseQuery(query), body == null ? null : body.getBytes(StandardCharsets.UTF_8)));
    }

    private static void allowed(TenantRoutePolicy.Decision d) {
        assertThat(d.allowed()).as(d.message()).isTrue();
    }

    private static void refused(TenantRoutePolicy.Decision d) {
        assertThat(d.allowed()).isFalse();
    }

    @Test
    void pathScopedRoutesFollowTheModelInThePath() {
        allowed(as("alice", "GET", "/api/explorer/alice-notes/catalogue", null, null));
        refused(as("alice", "GET", "/api/explorer/bob-notes/catalogue", null, null));
        refused(as("alice", "GET", "/api/explorer/default/catalogue", null, null));
        allowed(as("alice", "POST", "/node-api/events/execute/alice-notes", null, "{\"events\":[]}"));
        refused(as("alice", "POST", "/node-api/events/execute/bob-notes", null, "{\"events\":[]}"));
        allowed(as("alice", "GET", "/node-api/models/alice-notes/path/root/workspace/children", null, null));
        refused(as("alice", "GET", "/node-api/models/bob-notes/path/root/workspace/children", null, null));
        allowed(as("alice", "POST", "/api/proxy/arcql/alice-notes/query", null, "{\"query\":\"FROM $\"}"));
        refused(as("alice", "POST", "/api/proxy/arcql/bob-notes/query", null, "{\"query\":\"FROM $\"}"));
    }

    @Test
    void queryAndBodyScopedRoutesFollowTheirModelField() {
        allowed(as("alice", "GET", "/api/designtime/nets", "modelId=alice-notes&sessionId=s", null));
        refused(as("alice", "GET", "/api/designtime/nets", "modelId=bob-notes&sessionId=s", null));
        refused(as("alice", "GET", "/api/designtime/nets", "sessionId=s", null));
        allowed(as("alice", "POST", "/api/designtime/nets", null, "{\"modelId\":\"alice-notes\",\"netId\":\"n\"}"));
        refused(as("alice", "POST", "/api/designtime/nets", null, "{\"modelId\":\"bob-notes\",\"netId\":\"n\"}"));
        refused(as("alice", "POST", "/api/designtime/nets", null, "{\"netId\":\"n\"}"));
        allowed(as("alice", "POST", "/api/transitions/t1/start", null, "{\"modelId\":\"alice-notes\"}"));
        refused(as("alice", "POST", "/api/transitions/t1/start", null, "{\"modelId\":\"bob-notes\"}"));
        allowed(as("alice", "POST", "/api/hub/install", null, "{\"name\":\"kanban\",\"targetModelId\":\"alice-notes\"}"));
        refused(as("alice", "POST", "/api/hub/install", null, "{\"name\":\"kanban\",\"targetModelId\":\"bob-notes\"}"));
    }

    @Test
    void aSecondOrStrayModelCannotRideAlong() {
        refused(as("alice", "GET", "/api/designtime/nets", "modelId=alice-notes&modelId=bob-notes", null));
        refused(as("alice", "GET", "/api/models/alice-notes/structure", "modelId=bob-notes", null));
        refused(as("alice", "POST", "/api/transitions/t1/start", null,
                "{\"modelId\":\"alice-notes\",\"targetModelId\":\"bob-notes\"}"));
        refused(as("alice", "POST", "/node-api/events/execute/alice-notes", null, "{\"modelId\":\"bob-notes\"}"));
    }

    @Test
    void inscriptionHostsMustNameTheTenantsOwnModelsEvenInsideStrings() {
        String own = "{\"modelId\":\"alice-notes\",\"transitionId\":\"t\",\"inscription\":{\"presets\":{\"in\":"
                + "{\"placeId\":\"p\",\"host\":\"alice-notes@node:8080\"}}}}";
        allowed(as("alice", "POST", "/api/transitions/assign", null, own));
        String foreign = own.replace("alice-notes@node", "bob-notes@node");
        refused(as("alice", "POST", "/api/transitions/assign", null, foreign));
        // An inscription written as a node leaf carries its JSON as a string property.
        String leaf = "{\"events\":[{\"eventType\":\"createLeaf\",\"name\":\"inscription\",\"properties\":{\"value\":"
                + "\"{\\\"postsets\\\":{\\\"out\\\":{\\\"placeId\\\":\\\"p\\\",\\\"host\\\":\\\"bob-notes@node:8080\\\"}}}\"}}]}";
        refused(as("alice", "POST", "/node-api/events/execute/alice-notes", null, leaf));
    }

    @Test
    void theToolRouteChecksTheToolAndEveryModelItNames() {
        allowed(as("alice", "POST", "/api/agent/tools/QUERY_TOKENS/execute", null,
                "{\"modelId\":\"alice-notes\",\"params\":{\"placeId\":\"p\"}}"));
        refused(as("alice", "POST", "/api/agent/tools/QUERY_TOKENS/execute", null,
                "{\"modelId\":\"bob-notes\",\"params\":{\"placeId\":\"p\"}}"));
        refused(as("alice", "POST", "/api/agent/tools/HUB_INSTALL/execute", null,
                "{\"modelId\":\"alice-notes\",\"params\":{\"targetModelId\":\"bob-notes\"}}"));
        refused(as("alice", "POST", "/api/agent/tools/TOOL_CATALOG_SEARCH/execute", null,
                "{\"modelId\":\"alice-notes\",\"params\":{\"model\":\"default\"}}"));
        refused(as("alice", "POST", "/api/agent/tools/HUB_PUBLISH/execute", null,
                "{\"modelId\":\"alice-notes\",\"params\":{}}"));
        refused(as("alice", "POST", "/api/agent/tools/DOCKER_RUN/execute", null,
                "{\"modelId\":\"alice-notes\",\"params\":{}}"));
        refused(as("alice", "POST", "/api/agent/tools/invoke_persona/execute", null,
                "{\"modelId\":\"alice-notes\",\"params\":{}}"));
    }

    @Test
    void modelListsAndCreatesAreTheirOwnEffects() {
        TenantRoutePolicy.Decision list = as("alice", "GET", "/api/admin/models", null, null);
        allowed(list);
        assertThat(list.effect()).isEqualTo(TenantRoutePolicy.Effect.LIST_MODELS);
        TenantRoutePolicy.Decision create = as("alice", "POST", "/node-api/admin/models", null,
                "{\"modelId\":\"alice-new\",\"name\":\"New\"}");
        allowed(create);
        assertThat(create.effect()).isEqualTo(TenantRoutePolicy.Effect.CREATE_MODEL);
        assertThat(create.models()).containsExactly("alice-new");
        refused(as("alice", "POST", "/node-api/admin/models", null, "{\"modelId\":\"bob-new\",\"name\":\"x\"}"));
        refused(as("alice", "POST", "/node-api/admin/models", null, "{\"modelId\":\"plain\",\"name\":\"x\"}"));
    }

    @Test
    void operatorAndInstanceWideRoutesAreClosed() {
        for (String[] r : new String[][]{
                {"GET", "/api/hub/remotes"}, {"POST", "/api/hub/publish"}, {"POST", "/api/hub/remotes"},
                {"POST", "/api/packages"}, {"GET", "/api/packages"}, {"PUT", "/api/settings/system"},
                {"GET", "/api/system/llm-freeze"}, {"POST", "/api/system/llm-freeze"},
                {"POST", "/api/llm/execute"}, {"POST", "/api/assistant/universal/alice-notes/chat/start"},
                {"GET", "/api/docker/containers"}, {"POST", "/api/tool-catalog/http"},
                {"GET", "/api/transitions/discover"}, {"GET", "/api/transitions/poll"},
                {"GET", "/node-api/admin/catalog"}, {"POST", "/node-api/admin/backups/run"},
                {"POST", "/node-api/events/execute"}, {"GET", "/node-api/tree"},
                {"POST", "/node-api/models/import/complete"}, {"GET", "/api/tenants"},
                {"DELETE", "/api/shares/ref"}, {"GET", "/api/executors"}}) {
            refused(as("alice", r[0], r[1], null, null));
        }
        // Credentials: written and removed, never read back.
        allowed(as("alice", "POST", "/api/transitions/t/credentials", "modelId=alice-notes", "{\"token\":\"x\"}"));
        refused(as("alice", "GET", "/api/transitions/t/credentials", "modelId=alice-notes", null));
        // The grant of the platform's own MCP token is not a tenant's to give.
        refused(as("alice", "POST", "/api/applications/alice-notes/kanban/mcp/grant", null, "{}"));
        refused(as("alice", "POST", "/api/explorer/alice-notes/refinement/access", null, "{}"));
        allowed(as("alice", "GET", "/api/explorer/alice-notes/refinement/access", null, null));
        allowed(as("alice", "POST", "/api/explorer/alice-notes/refinement/rounds", null, "{}"));
    }

    @Test
    void aTenantExecutorPollsOnlyItsOwnModelsUnderItsOwnName() {
        allowed(exec("alice", "alice-laptop", "GET", "/api/transitions/poll", "modelId=alice-notes&executorId=alice-laptop", null));
        refused(exec("alice", "alice-laptop", "GET", "/api/transitions/poll", "modelId=bob-notes&executorId=alice-laptop", null));
        refused(exec("alice", "alice-laptop", "GET", "/api/transitions/poll", "modelId=alice-notes&executorId=bob-box", null));
        allowed(exec("alice", "alice-laptop", "GET", "/api/transitions/discover", "allowedModels=alice-a,alice-b", null));
        refused(exec("alice", "alice-laptop", "GET", "/api/transitions/discover", "allowedModels=alice-a,bob-b", null));
        refused(exec("alice", "alice-laptop", "GET", "/api/transitions/discover", null, null));
        refused(exec("alice", "alice-laptop", "GET", "/api/transitions/discover", "allowedModels=*", null));
        allowed(exec("alice", "alice-laptop", "POST", "/api/transitions/tokens/emit", null, "{\"modelId\":\"alice-notes\"}"));
        refused(exec("alice", "alice-laptop", "POST", "/api/transitions/tokens/emit", null, "{\"modelId\":\"bob-notes\"}"));
        // Its executor token is no user token.
        refused(exec("alice", "alice-laptop", "GET", "/api/explorer/alice-notes/catalogue", null, null));
    }

    @Test
    void nonJsonBodiesOnBodyScopedRoutesAreRefused() {
        refused(as("alice", "POST", "/api/designtime/nets", null, "modelId=alice-notes"));
    }
}
