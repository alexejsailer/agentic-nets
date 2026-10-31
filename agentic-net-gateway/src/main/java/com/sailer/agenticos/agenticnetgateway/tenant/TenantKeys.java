package com.sailer.agenticos.agenticnetgateway.tenant;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The shapes of tenant identities and secrets, in one place.
 *
 * <ul>
 *   <li>tenant id: 3 to 24 characters, lower-case letters and digits, starting with a letter. No dash,
 *       so the model prefix {@code <tenant>-} can never be read two ways.</li>
 *   <li>tenant key: {@code ant_<tenant>_<32 hex>}. One credential for MCP, Studio and the CLI.</li>
 *   <li>executor key: {@code axe_<tenant>_<name>_<32 hex>}; the executor id is {@code <tenant>-<name>}.</li>
 *   <li>tenant model: any model id starting with {@code <tenant>-}.</li>
 * </ul>
 * Keys are stored only as SHA-256 hashes and compared in constant time.
 */
public final class TenantKeys {

    private TenantKeys() {}

    public static final Pattern TENANT_ID = Pattern.compile("[a-z][a-z0-9]{2,23}");
    public static final Pattern EXECUTOR_NAME = Pattern.compile("[a-z0-9][a-z0-9-]{0,30}");
    /** A model id a tenant may own: its prefix plus a plain path segment. */
    private static final Pattern MODEL_SUFFIX = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,99}");

    private static final Pattern TENANT_KEY = Pattern.compile("ant_([a-z][a-z0-9]{2,23})_([0-9a-f]{32})");
    private static final Pattern EXECUTOR_KEY = Pattern.compile("axe_([a-z][a-z0-9]{2,23})_([a-z0-9][a-z0-9-]{0,30})_([0-9a-f]{32})");

    /** Ids that would read as the platform's own. */
    public static final Set<String> RESERVED = Set.of("default", "system", "agenticos", "admin", "mcp",
            "root", "internal", "operator", "readonly", "executor", "share", "tenant", "public", "staging");

    private static final SecureRandom RANDOM = new SecureRandom();

    public static boolean validTenantId(String id) {
        return id != null && TENANT_ID.matcher(id).matches() && !RESERVED.contains(id);
    }

    public static boolean validExecutorName(String name) {
        return name != null && EXECUTOR_NAME.matcher(name).matches();
    }

    /** The prefix every model of this tenant carries. */
    public static String modelPrefix(String tenant) {
        return tenant + "-";
    }

    /** True when the model id belongs to the tenant (prefix plus a non-empty, path-safe rest). */
    public static boolean ownsModel(String tenant, String modelId) {
        if (tenant == null || modelId == null) return false;
        String prefix = modelPrefix(tenant);
        return modelId.startsWith(prefix) && MODEL_SUFFIX.matcher(modelId.substring(prefix.length())).matches();
    }

    public static String executorId(String tenant, String name) {
        return tenant + "-" + name;
    }

    public static String newTenantKey(String tenant) {
        return "ant_" + tenant + "_" + randomHex();
    }

    public static String newExecutorKey(String tenant, String name) {
        return "axe_" + tenant + "_" + name + "_" + randomHex();
    }

    /** The tenant a tenant key names, or null when it is not a tenant key. */
    public static String tenantOfKey(String key) {
        if (key == null) return null;
        Matcher m = TENANT_KEY.matcher(key.trim());
        return m.matches() ? m.group(1) : null;
    }

    /** {tenant, executorName} for an executor key, or null. */
    public static String[] executorOfKey(String key) {
        if (key == null) return null;
        Matcher m = EXECUTOR_KEY.matcher(key.trim());
        return m.matches() ? new String[]{m.group(1), m.group(2)} : null;
    }

    public static boolean looksLikeTenantCredential(String secret) {
        return secret != null && (secret.startsWith("ant_") || secret.startsWith("axe_"));
    }

    public static String hash(String key) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(key.trim().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static boolean matches(String storedHash, String presentedKey) {
        if (storedHash == null || presentedKey == null) return false;
        byte[] a = storedHash.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8);
        byte[] b = hash(presentedKey).getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(a, b);
    }

    private static String randomHex() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }
}
