package com.sailer.agenticos.agenticnetgateway.tenant;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Tenancy switches ({@code AGENTICOS_TENANCY*}). Off by default: a single-operator install keeps
 * today's behaviour and no tenant key is ever accepted.
 */
@Component
public class TenancySettings {

    /** How people get an account: the operator issues keys (off), anyone with an invite code, or anyone. */
    public enum Signup { OFF, INVITE, OPEN }

    private final boolean enabled;
    private final Signup signup;
    private final List<String> inviteCodes;
    private final String publicMcpUrl;
    private final String publicStudioUrl;
    private final int maxBodyBytes;

    public TenancySettings(@Value("${gateway.tenancy.enabled:false}") boolean enabled,
                           @Value("${gateway.tenancy.signup:off}") String signup,
                           @Value("${gateway.tenancy.invite-codes:}") String inviteCodes,
                           @Value("${gateway.tenancy.public-mcp-url:}") String publicMcpUrl,
                           @Value("${gateway.tenancy.public-studio-url:}") String publicStudioUrl,
                           @Value("${gateway.tenancy.max-body-bytes:16777216}") int maxBodyBytes) {
        this.enabled = enabled;
        Signup s;
        try {
            s = Signup.valueOf(signup.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            s = Signup.OFF;
        }
        this.signup = enabled ? s : Signup.OFF;
        this.inviteCodes = Arrays.stream(inviteCodes.split(",")).map(String::trim).filter(c -> !c.isEmpty()).toList();
        this.publicMcpUrl = publicMcpUrl;
        this.publicStudioUrl = publicStudioUrl;
        this.maxBodyBytes = Math.max(1024, maxBodyBytes);
    }

    public boolean enabled() { return enabled; }
    public Signup signup() { return signup; }
    public List<String> inviteCodes() { return inviteCodes; }
    public String publicMcpUrl() { return publicMcpUrl; }
    public String publicStudioUrl() { return publicStudioUrl; }
    public int maxBodyBytes() { return maxBodyBytes; }
}
