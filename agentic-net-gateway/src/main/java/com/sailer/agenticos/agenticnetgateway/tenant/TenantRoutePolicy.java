package com.sailer.agenticos.agenticnetgateway.tenant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.server.PathContainer;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * What a tenant token may call, decided per request without any backend lookup. Pure and
 * stateless so the whole fence is unit-testable.
 *
 * <p><b>Default deny.</b> A route not in this table is refused for tenants, so a new master or
 * node route is unavailable to them until someone classifies it here. Each allowed route states
 * where its model id travels (path variable, query parameter or JSON body field); the model must
 * carry the tenant's prefix ({@link TenantKeys#ownsModel}). Every JSON body is also scanned for
 * inscription hosts ({@code "host": "<model>@node:port"}, including inscriptions stored as JSON
 * strings) and for model overrides, so a request about the tenant's own model cannot point a lane
 * or a tool at someone else's.</p>
 */
public final class TenantRoutePolicy {

    private TenantRoutePolicy() {}

    /** Where a route carries its model id. */
    public enum ModelAt { NONE, PATH, QUERY, QUERY_MODEL, BODY, BODY_TARGET, BODY_MODEL, QUERY_ALLOWED_MODELS }

    /** What the gateway does besides checking the model. */
    public enum Effect { MODEL, GLOBAL, LIST_MODELS, CREATE_MODEL, TOOL_EXECUTE, EXECUTOR_POLL }

    record Rule(Set<String> methods, PathPattern pattern, ModelAt at, Effect effect, boolean executor) {}

    public record Request(String method, String path, Map<String, String[]> query, byte[] body) {}

    public record Decision(boolean allowed, String error, String message, Effect effect, Set<String> models) {
        static Decision deny(String error, String message) {
            return new Decision(false, error, message, null, Set.of());
        }
    }

    private static final PathPatternParser PARSER = new PathPatternParser();
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<Rule> USER_RULES = new ArrayList<>();
    private static final List<Rule> EXECUTOR_RULES = new ArrayList<>();

    /** Native tools a tenant may never run: host-wide (docker, registry), instance-wide (hub, catalog), or AI coordination. */
    static final Set<String> DENIED_TOOLS = Set.of(
            "DOCKER_RUN", "DOCKER_STOP", "DOCKER_LIST", "DOCKER_LOGS", "WRAP_DOCKER_TOOL",
            "REGISTRY_LIST_IMAGES", "REGISTRY_GET_IMAGE_INFO",
            "TOOL_CATALOG_IMPORT_IMAGE", "TOOL_CATALOG_REGISTER_HTTP",
            "HUB_PUBLISH", "HUB_UNPUBLISH", "HUB_REMOTE_ADD", "HUB_REMOTE_REMOVE", "PACKAGE_PUBLISH",
            "MCP_CALL", "INVOKE_PERSONA", "DELEGATE_TASK", "COLLECT_RESULTS");

    /** Body keys that name a model wherever a request may carry one directly. */
    private static final Set<String> MODEL_KEYS = Set.of("modelId", "targetModelId", "sourceModelId");

    private static final String ANY = "*";

    static {
        // ---- master (/api) ----
        user("GET", "/api/admin/models", ModelAt.NONE, Effect.LIST_MODELS);
        user("POST", "/api/admin/models", ModelAt.BODY, Effect.CREATE_MODEL);
        user("GET,DELETE", "/api/admin/models/{modelId}", ModelAt.PATH);
        user("GET", "/api/admin/models/{modelId}/status", ModelAt.PATH);
        user("POST", "/api/admin/models/{modelId}/{op:load|unload|activate|deactivate|profile}", ModelAt.PATH);
        user("PUT", "/api/admin/models/{modelId}/autoload", ModelAt.PATH);
        user("GET", "/api/applications/{modelId}", ModelAt.PATH);
        user("GET", "/api/applications/{modelId}/{name}", ModelAt.PATH);
        user("GET", "/api/applications/{modelId}/{name}/{part:assets|stores|views}/**", ModelAt.PATH);
        user("GET", "/api/applications/{modelId}/{name}/mcp", ModelAt.PATH);
        user("POST", "/api/applications/{modelId}/{name}/actions/{action}", ModelAt.PATH);
        user(ANY, "/api/explorer/{modelId}", ModelAt.PATH);
        user(ANY, "/api/explorer/{modelId}/{first:(?!refinement$).*}/**", ModelAt.PATH);
        user(ANY, "/api/explorer/{modelId}/refinement/{part:(?!access$).*}/**", ModelAt.PATH);
        user("GET", "/api/explorer/{modelId}/refinement/access", ModelAt.PATH);
        user("GET", "/api/explorer/{modelId}/refinement", ModelAt.PATH);
        user("GET,DELETE", "/api/designtime/nets", ModelAt.QUERY);
        user("GET,DELETE", "/api/designtime/nets/**", ModelAt.QUERY);
        user("POST", "/api/designtime/nets", ModelAt.BODY);
        user("POST,PUT", "/api/designtime/nets/**", ModelAt.BODY);
        user("GET", "/api/event-line/{modelId}/**", ModelAt.PATH);
        user("GET", "/api/executors", ModelAt.QUERY);
        user(ANY, "/api/installed-agents/{modelId}/**", ModelAt.PATH);
        user(ANY, "/api/installed-contexts/{modelId}/**", ModelAt.PATH);
        user("GET", "/api/models/{modelId}/**", ModelAt.PATH);
        user(ANY, "/api/petrinet/{modelId}/**", ModelAt.PATH);
        user("POST", "/api/pnml", ModelAt.QUERY);
        user("GET", "/api/pnml/validate-structure", ModelAt.QUERY);
        user("GET", "/api/pnml/{modelId}/**", ModelAt.PATH);
        user("POST", "/api/proxy/arcql/{modelId}/query", ModelAt.PATH);
        user("POST", "/api/proxy/events/{modelId}/execute", ModelAt.PATH);
        user(ANY, "/api/proxy/io/{modelId}/**", ModelAt.PATH);
        user(ANY, "/api/proxy/properties/{modelId}/**", ModelAt.PATH);
        user(ANY, "/api/proxy/tree/{modelId}/**", ModelAt.PATH);
        user(ANY, "/api/runtime/places", ModelAt.QUERY);
        user(ANY, "/api/runtime/places/**", ModelAt.QUERY);
        user(ANY, "/api/runtime/transitions", ModelAt.QUERY);
        user(ANY, "/api/runtime/transitions/**", ModelAt.QUERY);
        user(ANY, "/api/sessions/{modelId}/**", ModelAt.PATH);
        user("GET", "/api/shares", ModelAt.QUERY);
        user("POST", "/api/shares", ModelAt.BODY);
        user("GET", "/api/tool-catalog", ModelAt.QUERY_MODEL);
        user("GET", "/api/tool-catalog/{id}", ModelAt.QUERY_MODEL);
        user("POST", "/api/tool-catalog/scripts", ModelAt.BODY_MODEL);
        user("GET", "/api/toolnets/library", ModelAt.NONE, Effect.GLOBAL);
        user("GET", "/api/toolnets/{modelId}/{part:candidates|health}", ModelAt.PATH);
        user("POST", "/api/toolnets/{modelId}/{sessionId}/{netId}/promote", ModelAt.PATH);
        user("POST", "/api/transitions/assign", ModelAt.BODY);
        user("GET", "/api/transitions/external/ready", ModelAt.QUERY);
        user("POST", "/api/transitions/external/policy", ModelAt.BODY);
        user("POST", "/api/transitions/{id}/{op:start|stop|fireOnce|delete|external}", ModelAt.BODY);
        user("POST", "/api/transitions/{id}/external/{op:prepare|complete|abandon|authorize-tool}", ModelAt.BODY);
        user("POST", "/api/transitions/{id}/{op:cancelFireOnce|diagnose|dry-run|verify-inscription}", ModelAt.QUERY);
        // Credentials can be written and removed, never read back (plaintext).
        user("POST,DELETE", "/api/transitions/{id}/credentials", ModelAt.QUERY);
        user("GET", "/api/transitions/{id}/status", ModelAt.QUERY);
        user("POST", "/api/dryrun/transitions/{id}", ModelAt.BODY);
        user("POST", "/api/verify/transitions/{id}/inscription", ModelAt.BODY);
        user("GET", "/api/usage/**", ModelAt.QUERY);
        user("POST", "/api/workspace/{modelId}/**", ModelAt.PATH);
        user("GET", "/api/agent/tools/catalog", ModelAt.NONE, Effect.GLOBAL);
        user("GET", "/api/agent/tools/mcp/catalog", ModelAt.QUERY);
        user("POST", "/api/agent/tools/{tool}/execute", ModelAt.BODY, Effect.TOOL_EXECUTE);
        user("GET", "/api/hub/catalog", ModelAt.NONE, Effect.GLOBAL);
        user("GET", "/api/hub/health", ModelAt.NONE, Effect.GLOBAL);
        user("GET", "/api/hub/artifacts/**", ModelAt.NONE, Effect.GLOBAL);
        user("POST", "/api/hub/install", ModelAt.BODY_TARGET);
        user("GET", "/api/system/features", ModelAt.NONE, Effect.GLOBAL);
        user("GET", "/api/llm/health", ModelAt.NONE, Effect.GLOBAL);
        user("GET", "/api/tokens/places/{placeId}", ModelAt.QUERY);
        user("GET,HEAD", "/api/blobs/**", ModelAt.NONE, Effect.GLOBAL);
        user("GET", "/api/assistant/universal/{modelId}/query/**", ModelAt.PATH);
        user("GET", "/api/assistant/universal/{modelId}/tools", ModelAt.PATH);
        user("GET", "/api/assistant/p/personas", ModelAt.NONE, Effect.GLOBAL);

        // ---- node (/node-api) ----
        user("GET", "/node-api/admin/models", ModelAt.NONE, Effect.LIST_MODELS);
        user("POST", "/node-api/admin/models", ModelAt.BODY, Effect.CREATE_MODEL);
        user("GET,DELETE", "/node-api/admin/models/{modelId}", ModelAt.PATH);
        user("GET", "/node-api/admin/models/{modelId}/{part:status|statistics|tree|children}", ModelAt.PATH);
        user("POST", "/node-api/admin/models/{modelId}/{op:load|unload|activate|deactivate|snapshot}", ModelAt.PATH);
        user("POST", "/node-api/admin/models/{modelId}/{kind:leaves|nodes}", ModelAt.PATH);
        user("DELETE", "/node-api/admin/models/{modelId}/{kind:leaves|nodes}/{id}", ModelAt.PATH);
        user("POST", "/node-api/arcql/query/{modelId}", ModelAt.PATH);
        user("GET", "/node-api/arcql/help", ModelAt.NONE, Effect.GLOBAL);
        user("POST", "/node-api/arcql/validate", ModelAt.NONE, Effect.GLOBAL);
        user("POST", "/node-api/events/execute/{modelId}", ModelAt.PATH);
        user("GET", "/node-api/export/{kind:json|tree}/{modelId}", ModelAt.PATH);
        user("POST", "/node-api/import/json", ModelAt.QUERY);
        user(ANY, "/node-api/models/{modelId}/**", ModelAt.PATH);
        user("POST", "/node-api/pnml/places/{modelId}/tokens/bulk", ModelAt.PATH);

        // ---- a tenant's own executors: the polling protocol, on its own models only ----
        executor("GET", "/api/transitions/poll", ModelAt.QUERY, Effect.EXECUTOR_POLL);
        executor("GET", "/api/transitions/discover", ModelAt.QUERY_ALLOWED_MODELS, Effect.EXECUTOR_POLL);
        executor("POST", "/api/transitions/{id}/deployment", ModelAt.BODY, Effect.MODEL);
        executor("POST", "/api/transitions/tokens/{op:emit|consume|release}", ModelAt.BODY, Effect.MODEL);
    }

    private static void user(String methods, String pattern, ModelAt at) {
        user(methods, pattern, at, Effect.MODEL);
    }

    private static void user(String methods, String pattern, ModelAt at, Effect effect) {
        USER_RULES.add(rule(methods, pattern, at, effect, false));
    }

    private static void executor(String methods, String pattern, ModelAt at, Effect effect) {
        EXECUTOR_RULES.add(rule(methods, pattern, at, effect, true));
    }

    private static Rule rule(String methods, String pattern, ModelAt at, Effect effect, boolean executor) {
        Set<String> m = ANY.equals(methods) ? Set.of(ANY)
                : Set.copyOf(Arrays.stream(methods.split(",")).map(s -> s.trim().toUpperCase(Locale.ROOT)).toList());
        return new Rule(m, PARSER.parse(pattern), at, effect, executor);
    }

    /** Decide one tenant request. {@code executorId} is the token's executor claim for tenant executors, else null. */
    public static Decision decide(String tenant, String executorId, Request r) {
        if (tenant == null || r.path() == null) {
            return Decision.deny("tenant_scope", "No tenant on this token.");
        }
        boolean isExecutor = executorId != null;
        String method = r.method() == null ? "GET" : r.method().toUpperCase(Locale.ROOT);
        PathContainer path = PathContainer.parsePath(r.path());
        Rule matched = null;
        PathPattern.PathMatchInfo info = null;
        for (Rule rule : isExecutor ? EXECUTOR_RULES : USER_RULES) {
            if (!rule.methods().contains(ANY) && !rule.methods().contains(method)) continue;
            PathPattern.PathMatchInfo i = rule.pattern().matchAndExtract(path);
            if (i != null) {
                matched = rule;
                info = i;
                break;
            }
        }
        if (matched == null) {
            return Decision.deny("tenant_scope", (isExecutor
                    ? "A tenant executor may only use the polling protocol on its own models: "
                    : "This route is not available to tenant accounts: ") + method + " " + r.path());
        }

        // Any model named in the query must be the tenant's, whatever the route reads: a second
        // value or a stray parameter must not steer routing or a backend that reads it differently.
        if (r.query() != null) {
            for (String key : List.of("modelId", "model", "targetModelId")) {
                String[] values = r.query().get(key);
                if (values == null) continue;
                if (values.length > 1) {
                    return Decision.deny("tenant_scope", "The query names '" + key + "' more than once.");
                }
                if (!"model".equals(key) || matched.at() == ModelAt.QUERY_MODEL) {
                    String v = values[0];
                    if (v != null && !v.isBlank() && !TenantKeys.ownsModel(tenant, v)) {
                        return Decision.deny("tenant_model", "Model '" + v + "' is not one of yours; your models start with '"
                                + TenantKeys.modelPrefix(tenant) + "'.");
                    }
                }
            }
        }

        JsonNode body = parseBody(r.body());
        if (r.body() != null && r.body().length > 0 && body == null && matched.at().name().startsWith("BODY")) {
            return Decision.deny("tenant_scope", "The request body must be JSON so its model can be checked.");
        }

        Set<String> models = new LinkedHashSet<>();
        switch (matched.at()) {
            case PATH -> models.add(info.getUriVariables().get("modelId"));
            case QUERY -> models.add(first(r.query(), "modelId"));
            case QUERY_MODEL -> models.add(first(r.query(), "model"));
            case BODY -> models.add(text(body, "modelId"));
            case BODY_TARGET -> models.add(text(body, "targetModelId"));
            case BODY_MODEL -> models.add(text(body, "model"));
            case QUERY_ALLOWED_MODELS -> {
                String all = first(r.query(), "allowedModels");
                if (all != null) {
                    for (String s : all.split(",")) if (!s.isBlank()) models.add(s.trim());
                }
                if (models.isEmpty()) models.add(null);
            }
            case NONE -> { }
        }
        for (String m : models) {
            if (m == null || m.isBlank()) {
                return Decision.deny("tenant_scope", "This route needs a model of yours (" + matched.at().name().toLowerCase(Locale.ROOT)
                        + " '" + modelField(matched.at()) + "'); models of tenant '" + tenant + "' start with '"
                        + TenantKeys.modelPrefix(tenant) + "'.");
            }
            if (!TenantKeys.ownsModel(tenant, m)) {
                return Decision.deny("tenant_model", "Model '" + m + "' is not one of yours; your models start with '"
                        + TenantKeys.modelPrefix(tenant) + "'.");
            }
        }

        if (isExecutor && matched.effect() == Effect.EXECUTOR_POLL) {
            String claimed = first(r.query(), "executorId");
            if (claimed != null && !claimed.equals(executorId)) {
                return Decision.deny("executor_identity", "This token is bound to executor '" + executorId + "'.");
            }
        }

        if (matched.effect() == Effect.TOOL_EXECUTE) {
            String tool = info.getUriVariables().getOrDefault("tool", "").toUpperCase(Locale.ROOT);
            if (DENIED_TOOLS.contains(tool)) {
                return Decision.deny("tenant_scope", "The tool " + tool + " is not available to tenant accounts.");
            }
            JsonNode params = body == null ? null : body.get("params");
            JsonNode scan = params != null && params.isObject() ? params : body;
            for (String key : List.of("modelId", "targetModelId", "sourceModelId", "model")) {
                String v = text(scan, key);
                if (v != null && !v.isBlank() && !TenantKeys.ownsModel(tenant, v)) {
                    return Decision.deny("tenant_model", "Tool parameter '" + key + "' names model '" + v + "', which is not yours.");
                }
            }
        }

        if (body != null) {
            for (String key : MODEL_KEYS) {
                String v = text(body, key);
                if (v != null && !v.isBlank() && !TenantKeys.ownsModel(tenant, v)) {
                    return Decision.deny("tenant_model", "Body field '" + key + "' names model '" + v + "', which is not yours.");
                }
            }
            String foreign = foreignHost(body, tenant, 0);
            if (foreign != null) {
                return Decision.deny("tenant_model", "An inscription host names model '" + foreign
                        + "', which is not yours: places must live in your own models.");
            }
        }
        return new Decision(true, null, null, matched.effect(), models);
    }

    /** True when the route exists for tenants at all (any method), for diagnostics. */
    public static int ruleCount() {
        return USER_RULES.size() + EXECUTOR_RULES.size();
    }

    private static String modelField(ModelAt at) {
        return switch (at) {
            case QUERY_MODEL, BODY_MODEL -> "model";
            case BODY_TARGET -> "targetModelId";
            case QUERY_ALLOWED_MODELS -> "allowedModels";
            default -> "modelId";
        };
    }

    /**
     * The first model named by an inscription host ({@code model@node:port}) that the tenant does
     * not own, searching the whole body including inscriptions carried as JSON strings.
     */
    static String foreignHost(JsonNode node, String tenant, int depth) {
        if (node == null || depth > 12) return null;
        if (node.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = node.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                JsonNode v = e.getValue();
                if ("host".equals(e.getKey()) && v.isTextual()) {
                    String h = v.asText();
                    int at = h.indexOf('@');
                    if (at > 0) {
                        String model = h.substring(0, at);
                        if (!TenantKeys.ownsModel(tenant, model)) return model;
                    }
                }
                String found = foreignHost(v, tenant, depth + 1);
                if (found != null) return found;
            }
        } else if (node.isArray()) {
            for (JsonNode v : node) {
                String found = foreignHost(v, tenant, depth + 1);
                if (found != null) return found;
            }
        } else if (node.isTextual()) {
            String s = node.asText().trim();
            if (s.length() > 10 && s.startsWith("{") && s.endsWith("}") && s.contains("\"host\"")) {
                return foreignHost(parseBody(s.getBytes(java.nio.charset.StandardCharsets.UTF_8)), tenant, depth + 1);
            }
        }
        return null;
    }

    static JsonNode parseBody(byte[] body) {
        if (body == null || body.length == 0) return null;
        try {
            JsonNode n = MAPPER.readTree(body);
            return n != null && (n.isObject() || n.isArray()) ? n : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        if (node == null || !node.isObject()) return null;
        JsonNode v = node.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    private static String first(Map<String, String[]> query, String name) {
        if (query == null) return null;
        String[] v = query.get(name);
        return v == null || v.length == 0 ? null : v[0];
    }
}
