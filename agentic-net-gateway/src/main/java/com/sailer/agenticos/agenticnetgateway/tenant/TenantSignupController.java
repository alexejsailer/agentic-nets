package com.sailer.agenticos.agenticnetgateway.tenant;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public account endpoints (no token):
 * <ul>
 *   <li>{@code GET  /oauth2/tenancy} — whether this gateway takes tenant accounts and how people get one,
 *       so Studio and the docs can show the right sign-in.</li>
 *   <li>{@code POST /oauth2/register {tenant, inviteCode?}} — self-service sign-up when
 *       {@code gateway.tenancy.signup} is {@code invite} (a valid invite code) or {@code open}. The key is
 *       in the answer, once. Rate-limited per address like the token endpoint.</li>
 * </ul>
 */
@RestController
public class TenantSignupController {

    private static final Logger log = LoggerFactory.getLogger(TenantSignupController.class);

    private final TenantRegistry registry;
    private final TenancySettings settings;

    public TenantSignupController(TenantRegistry registry, TenancySettings settings) {
        this.registry = registry;
        this.settings = settings;
    }

    @GetMapping("/oauth2/tenancy")
    public Map<String, Object> tenancy() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("enabled", settings.enabled());
        m.put("signup", settings.signup().name().toLowerCase());
        m.put("keyPrefix", "ant_");
        if (settings.publicMcpUrl() != null && !settings.publicMcpUrl().isBlank()) m.put("mcpUrl", settings.publicMcpUrl());
        return m;
    }

    @PostMapping("/oauth2/register")
    public ResponseEntity<Object> register(@RequestBody(required = false) Map<String, Object> body) {
        if (!settings.enabled() || settings.signup() == TenancySettings.Signup.OFF) {
            return ResponseEntity.status(404).body(Map.of("error", "signup_closed",
                    "message", "Accounts on this platform are issued by its operator."));
        }
        Map<String, Object> b = body == null ? Map.of() : body;
        String tenant = b.get("tenant") == null ? null : b.get("tenant").toString().trim().toLowerCase();
        if (settings.signup() == TenancySettings.Signup.INVITE) {
            String code = b.get("inviteCode") == null ? "" : b.get("inviteCode").toString().trim();
            if (settings.inviteCodes().stream().noneMatch(c -> MessageDigest.isEqual(
                    c.getBytes(StandardCharsets.UTF_8), code.getBytes(StandardCharsets.UTF_8)))) {
                return ResponseEntity.status(403).body(Map.of("error", "invalid_invite", "message", "That invite code is not valid."));
            }
        }
        try {
            TenantRegistry.Issued issued = registry.create(tenant, "signup", null, null);
            log.info("Tenant '{}' signed up ({})", tenant, settings.signup());
            return ResponseEntity.status(201).body(TenantAdminController.issuedView(issued, settings));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_tenant", "message", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(409).body(Map.of("error", "tenant_exists", "message", "That name is taken."));
        }
    }
}
