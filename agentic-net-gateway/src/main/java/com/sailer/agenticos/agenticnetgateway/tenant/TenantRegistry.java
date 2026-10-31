package com.sailer.agenticos.agenticnetgateway.tenant;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The tenants this gateway knows: who they are, the hash of their key, their limits and the
 * executors they run. Persisted as {@code <jwt-key-dir>/tenants.json} (chmod 600, atomic rewrite),
 * held in memory, consulted on every tenant request so a disabled tenant or a rotated key stops
 * working at once rather than when its last token expires.
 *
 * <p>Only hashes are stored. A key is shown once, when it is created or rotated.</p>
 */
@Service
public class TenantRegistry {

    private static final Logger log = LoggerFactory.getLogger(TenantRegistry.class);

    /** One tenant. {@code keyVersion} increases on rotation; tokens carry it and die with it. */
    public record Tenant(String id, String keyHash, int keyVersion, String createdAt, String createdBy,
                         int modelsMax, int rateLimitPerMinute, boolean disabled,
                         List<Executor> executors) {
        public Tenant {
            executors = executors == null ? List.of() : List.copyOf(executors);
        }

        Tenant withKey(String hash) {
            return new Tenant(id, hash, keyVersion + 1, createdAt, createdBy, modelsMax, rateLimitPerMinute, disabled, executors);
        }

        Tenant withDisabled(boolean d) {
            return new Tenant(id, keyHash, keyVersion, createdAt, createdBy, modelsMax, rateLimitPerMinute, d, executors);
        }

        Tenant withLimits(int models, int rate) {
            return new Tenant(id, keyHash, keyVersion, createdAt, createdBy, models, rate, disabled, executors);
        }

        Tenant withExecutors(List<Executor> list) {
            return new Tenant(id, keyHash, keyVersion, createdAt, createdBy, modelsMax, rateLimitPerMinute, disabled, list);
        }

        /** The public view: never the hash. */
        public Map<String, Object> view() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("tenant", id);
            m.put("modelPrefix", TenantKeys.modelPrefix(id));
            m.put("createdAt", createdAt);
            m.put("createdBy", createdBy);
            m.put("modelsMax", modelsMax);
            m.put("rateLimitPerMinute", rateLimitPerMinute);
            m.put("disabled", disabled);
            m.put("keyVersion", keyVersion);
            m.put("executors", executors.stream().map(e -> Map.of("name", e.name(),
                    "executorId", TenantKeys.executorId(id, e.name()), "createdAt", e.createdAt())).toList());
            return m;
        }
    }

    public record Executor(String name, String keyHash, String createdAt) {}

    /** A key handed out once together with the tenant it belongs to. */
    public record Issued(Tenant tenant, String key) {}

    private final Path file;
    private final ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
    private final int defaultModelsMax;
    private final int defaultRateLimit;
    private final Map<String, Tenant> tenants = new LinkedHashMap<>();

    @org.springframework.beans.factory.annotation.Autowired
    public TenantRegistry(GatewayProperties props,
                          @Value("${gateway.tenancy.models-max:5}") int defaultModelsMax,
                          @Value("${gateway.tenancy.rate-limit-per-minute:300}") int defaultRateLimit) {
        this(Path.of(props.getJwtKeyDir(), "tenants.json"), defaultModelsMax, defaultRateLimit);
    }

    public TenantRegistry(Path file, int defaultModelsMax, int defaultRateLimit) {
        this.file = file;
        this.defaultModelsMax = Math.max(1, defaultModelsMax);
        this.defaultRateLimit = Math.max(10, defaultRateLimit);
        load();
    }

    @SuppressWarnings("unchecked")
    private synchronized void load() {
        tenants.clear();
        if (!Files.isRegularFile(file)) {
            return;
        }
        try {
            Map<String, Object> root = mapper.readValue(file.toFile(), Map.class);
            Object list = root.get("tenants");
            if (list instanceof List<?> l) {
                for (Object o : l) {
                    Tenant t = mapper.convertValue(o, Tenant.class);
                    if (t != null && TenantKeys.validTenantId(t.id())) tenants.put(t.id(), t);
                }
            }
            log.info("Tenant registry loaded: {} tenant(s) from {}", tenants.size(), file);
        } catch (IOException e) {
            // Fail closed: an unreadable registry admits nobody, it never admits everybody.
            log.error("Tenant registry {} is unreadable; no tenant can sign in until it is fixed: {}", file, e.getMessage());
        }
    }

    private void save() {
        try {
            Files.createDirectories(file.getParent());
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            mapper.writeValue(tmp.toFile(), Map.of("format", "agenticos-tenants", "version", 1,
                    "tenants", new ArrayList<>(tenants.values())));
            try {
                Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException ignored) {
                // non-POSIX file system (Windows): the directory permissions apply
            }
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new IllegalStateException("could not write the tenant registry: " + e.getMessage(), e);
        }
    }

    public synchronized Optional<Tenant> get(String id) {
        return Optional.ofNullable(id == null ? null : tenants.get(id));
    }

    public synchronized List<Tenant> list() {
        return List.copyOf(tenants.values());
    }

    /** Create a tenant and return its key (shown once). */
    public synchronized Issued create(String id, String by, Integer modelsMax, Integer rateLimit) {
        if (!TenantKeys.validTenantId(id)) {
            throw new IllegalArgumentException("tenant id must be 3-24 lower-case letters and digits, starting with a letter, "
                    + "and not one of " + TenantKeys.RESERVED);
        }
        if (tenants.containsKey(id)) {
            throw new IllegalStateException("tenant '" + id + "' already exists");
        }
        String key = TenantKeys.newTenantKey(id);
        Tenant t = new Tenant(id, TenantKeys.hash(key), 1, Instant.now().toString(), by == null ? "operator" : by,
                modelsMax != null && modelsMax > 0 ? modelsMax : defaultModelsMax,
                rateLimit != null && rateLimit > 0 ? rateLimit : defaultRateLimit, false, List.of());
        tenants.put(id, t);
        save();
        log.info("Tenant '{}' created by {}", id, t.createdBy());
        return new Issued(t, key);
    }

    /** Replace the key; every token minted with the old one stops working on its next request. */
    public synchronized Issued rotate(String id) {
        Tenant t = require(id);
        String key = TenantKeys.newTenantKey(id);
        Tenant next = t.withKey(TenantKeys.hash(key));
        tenants.put(id, next);
        save();
        log.info("Tenant '{}' key rotated (version {})", id, next.keyVersion());
        return new Issued(next, key);
    }

    public synchronized Tenant setDisabled(String id, boolean disabled) {
        Tenant next = require(id).withDisabled(disabled);
        tenants.put(id, next);
        save();
        log.info("Tenant '{}' {}", id, disabled ? "disabled" : "enabled");
        return next;
    }

    public synchronized Tenant setLimits(String id, Integer modelsMax, Integer rateLimit) {
        Tenant t = require(id);
        Tenant next = t.withLimits(modelsMax != null && modelsMax > 0 ? modelsMax : t.modelsMax(),
                rateLimit != null && rateLimit > 0 ? rateLimit : t.rateLimitPerMinute());
        tenants.put(id, next);
        save();
        return next;
    }

    /** Add (or re-key) an executor of this tenant; returns its key (shown once). */
    public synchronized Issued addExecutor(String id, String name) {
        if (!TenantKeys.validExecutorName(name)) {
            throw new IllegalArgumentException("executor name must be 1-31 lower-case letters, digits or dashes");
        }
        Tenant t = require(id);
        String key = TenantKeys.newExecutorKey(id, name);
        List<Executor> list = new ArrayList<>(t.executors().stream().filter(e -> !e.name().equals(name)).toList());
        list.add(new Executor(name, TenantKeys.hash(key), Instant.now().toString()));
        Tenant next = t.withExecutors(list);
        tenants.put(id, next);
        save();
        log.info("Tenant '{}' executor '{}' issued", id, name);
        return new Issued(next, key);
    }

    public synchronized Tenant removeExecutor(String id, String name) {
        Tenant t = require(id);
        Tenant next = t.withExecutors(t.executors().stream().filter(e -> !e.name().equals(name)).toList());
        tenants.put(id, next);
        save();
        return next;
    }

    public synchronized boolean remove(String id) {
        boolean removed = tenants.remove(id) != null;
        if (removed) save();
        return removed;
    }

    /** The tenant a presented tenant key authenticates, if any (enabled, hash matches). */
    public synchronized Optional<Tenant> authenticate(String key) {
        String id = TenantKeys.tenantOfKey(key);
        Tenant t = id == null ? null : tenants.get(id);
        if (t == null || t.disabled() || !TenantKeys.matches(t.keyHash(), key)) return Optional.empty();
        return Optional.of(t);
    }

    /** {tenant, executor} for a presented executor key, if any. */
    public synchronized Optional<Map.Entry<Tenant, Executor>> authenticateExecutor(String key) {
        String[] parts = TenantKeys.executorOfKey(key);
        Tenant t = parts == null ? null : tenants.get(parts[0]);
        if (t == null || t.disabled()) return Optional.empty();
        for (Executor e : t.executors()) {
            if (e.name().equals(parts[1]) && TenantKeys.matches(e.keyHash(), key)) {
                return Optional.of(Map.entry(t, e));
            }
        }
        return Optional.empty();
    }

    /** Whether a token minted for this tenant (and key version, and executor if any) still holds. */
    public synchronized boolean stillValid(String id, Integer keyVersion, String executorName) {
        Tenant t = tenants.get(id);
        if (t == null || t.disabled()) return false;
        if (executorName != null) {
            return t.executors().stream().anyMatch(e -> e.name().equals(executorName));
        }
        return keyVersion != null && keyVersion == t.keyVersion();
    }

    private Tenant require(String id) {
        Tenant t = tenants.get(id);
        if (t == null) throw new IllegalArgumentException("no tenant '" + id + "'");
        return t;
    }
}
