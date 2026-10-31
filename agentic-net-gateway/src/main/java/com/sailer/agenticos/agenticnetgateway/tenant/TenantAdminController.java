package com.sailer.agenticos.agenticnetgateway.tenant;

import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The operator's tenant administration (admin token only), served by the gateway itself:
 * <ul>
 *   <li>{@code GET    /api/tenants} — every tenant (never a key or hash)</li>
 *   <li>{@code POST   /api/tenants {tenant, modelsMax?, rateLimitPerMinute?}} — create; the key is in the answer, once</li>
 *   <li>{@code POST   /api/tenants/{id}/rotate} — new key, old tokens die at once</li>
 *   <li>{@code POST   /api/tenants/{id}/disable|enable}</li>
 *   <li>{@code POST   /api/tenants/{id}/limits {modelsMax?, rateLimitPerMinute?}}</li>
 *   <li>{@code POST   /api/tenants/{id}/executors {name}} — an executor key for {@code <id>-<name>}, once</li>
 *   <li>{@code DELETE /api/tenants/{id}/executors/{name}}, {@code DELETE /api/tenants/{id}}</li>
 * </ul>
 * Deleting a tenant does not delete its models; they become operator models nobody else can open.
 */
@RestController
@RequestMapping("/api/tenants")
public class TenantAdminController {

    private final TenantRegistry registry;
    private final TenancySettings settings;

    public TenantAdminController(TenantRegistry registry, TenancySettings settings) {
        this.registry = registry;
        this.settings = settings;
    }

    @GetMapping
    public ResponseEntity<Object> list() {
        if (!admin()) return forbidden();
        return ResponseEntity.ok(Map.of("enabled", settings.enabled(), "signup", settings.signup().name().toLowerCase(),
                "tenants", registry.list().stream().map(TenantRegistry.Tenant::view).toList()));
    }

    @PostMapping
    public ResponseEntity<Object> create(@RequestBody Map<String, Object> body) {
        if (!admin()) return forbidden();
        try {
            TenantRegistry.Issued issued = registry.create(str(body.get("tenant")), "operator",
                    integer(body.get("modelsMax")), integer(body.get("rateLimitPerMinute")));
            return ResponseEntity.status(201).body(issuedView(issued, settings));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_tenant", "message", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(409).body(Map.of("error", "tenant_exists", "message", e.getMessage()));
        }
    }

    @PostMapping("/{id}/rotate")
    public ResponseEntity<Object> rotate(@PathVariable String id) {
        if (!admin()) return forbidden();
        return guard(() -> issuedView(registry.rotate(id), settings));
    }

    @PostMapping("/{id}/disable")
    public ResponseEntity<Object> disable(@PathVariable String id) {
        if (!admin()) return forbidden();
        return guard(() -> registry.setDisabled(id, true).view());
    }

    @PostMapping("/{id}/enable")
    public ResponseEntity<Object> enable(@PathVariable String id) {
        if (!admin()) return forbidden();
        return guard(() -> registry.setDisabled(id, false).view());
    }

    @PostMapping("/{id}/limits")
    public ResponseEntity<Object> limits(@PathVariable String id, @RequestBody Map<String, Object> body) {
        if (!admin()) return forbidden();
        return guard(() -> registry.setLimits(id, integer(body.get("modelsMax")), integer(body.get("rateLimitPerMinute"))).view());
    }

    @PostMapping("/{id}/executors")
    public ResponseEntity<Object> addExecutor(@PathVariable String id, @RequestBody Map<String, Object> body) {
        if (!admin()) return forbidden();
        return guard(() -> {
            String name = str(body.get("name"));
            TenantRegistry.Issued issued = registry.addExecutor(id, name);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("tenant", id);
            m.put("executorId", TenantKeys.executorId(id, name));
            m.put("executorKey", issued.key());
            m.put("note", "Shown once. Run the executor with EXECUTOR_ID=" + TenantKeys.executorId(id, name)
                    + ", EXECUTOR_AUTH_CLIENT_SECRET=<this key> and EXECUTOR_MODELS set to your model ids.");
            return m;
        });
    }

    @DeleteMapping("/{id}/executors/{name}")
    public ResponseEntity<Object> removeExecutor(@PathVariable String id, @PathVariable String name) {
        if (!admin()) return forbidden();
        return guard(() -> registry.removeExecutor(id, name).view());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Object> remove(@PathVariable String id) {
        if (!admin()) return forbidden();
        return registry.remove(id) ? ResponseEntity.noContent().build()
                : ResponseEntity.status(404).body(Map.of("error", "no_tenant"));
    }

    /** The answer that carries a key: everything a person needs to connect, once. */
    static Map<String, Object> issuedView(TenantRegistry.Issued issued, TenancySettings settings) {
        Map<String, Object> m = new LinkedHashMap<>(issued.tenant().view());
        m.put("key", issued.key());
        m.put("keyShownOnce", true);
        if (settings.publicMcpUrl() != null && !settings.publicMcpUrl().isBlank()) {
            m.put("mcpUrl", settings.publicMcpUrl());
            m.put("connect", "claude mcp add --transport http agenticnets " + settings.publicMcpUrl()
                    + " --header \"Authorization: Bearer " + issued.key() + "\"");
        }
        if (settings.publicStudioUrl() != null && !settings.publicStudioUrl().isBlank()) {
            m.put("studioUrl", settings.publicStudioUrl());
        }
        return m;
    }

    private static boolean admin() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!(auth instanceof JwtAuthenticationToken jwt)) return false;
        String scope = jwt.getToken().getClaimAsString("scope");
        if (scope == null || jwt.getToken().getClaimAsString("tenant") != null) return false;
        for (String p : scope.split("\\s+")) if ("admin".equals(p)) return true;
        return false;
    }

    private static ResponseEntity<Object> forbidden() {
        return ResponseEntity.status(403).body(Map.of("error", "admin_only", "message", "Tenant administration needs the operator's admin token."));
    }

    private static ResponseEntity<Object> guard(java.util.function.Supplier<Object> action) {
        try {
            return ResponseEntity.ok(action.get());
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(e.getMessage() != null && e.getMessage().startsWith("no tenant") ? 404 : 400)
                    .body(Map.of("error", "invalid_request", "message", String.valueOf(e.getMessage())));
        }
    }

    private static String str(Object o) {
        return o == null ? null : o.toString().trim();
    }

    private static Integer integer(Object o) {
        if (o instanceof Number n) return n.intValue();
        try {
            return o == null ? null : Integer.parseInt(o.toString().trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
