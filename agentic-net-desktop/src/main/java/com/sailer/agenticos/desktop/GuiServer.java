package com.sailer.agenticos.desktop;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;

/**
 * Serves the compiled Angular GUI on port 4200 and reverse-proxies the
 * gateway-bound prefixes — the same contract as the production nginx image.
 * Port 4200 matters: it flips the GUI's isBehindReverseProxy() heuristic so
 * every in-app URL stays relative (single-origin, no CORS surprises).
 */
public final class GuiServer {

    private static final Set<String> PROXY_PREFIXES = Set.of("/oauth2", "/api", "/node-api", "/vault-api");
    /** Headers HttpClient sets itself or that must not be forwarded hop-to-hop. */
    private static final Set<String> SKIP_REQUEST_HEADERS = Set.of(
        "host", "connection", "content-length", "expect", "upgrade", "transfer-encoding");
    private static final Set<String> SKIP_RESPONSE_HEADERS = Set.of(
        "connection", "content-length", "transfer-encoding", "keep-alive");

    private static final Map<String, String> CONTENT_TYPES = Map.ofEntries(
        Map.entry("html", "text/html; charset=utf-8"),
        Map.entry("js", "text/javascript; charset=utf-8"),
        Map.entry("mjs", "text/javascript; charset=utf-8"),
        Map.entry("css", "text/css; charset=utf-8"),
        Map.entry("json", "application/json"),
        Map.entry("svg", "image/svg+xml"),
        Map.entry("png", "image/png"),
        Map.entry("jpg", "image/jpeg"),
        Map.entry("jpeg", "image/jpeg"),
        Map.entry("gif", "image/gif"),
        Map.entry("ico", "image/x-icon"),
        Map.entry("woff", "font/woff"),
        Map.entry("woff2", "font/woff2"),
        Map.entry("ttf", "font/ttf"),
        Map.entry("map", "application/json"),
        Map.entry("txt", "text/plain; charset=utf-8"),
        Map.entry("md", "text/markdown; charset=utf-8"),
        Map.entry("wasm", "application/wasm"));

    private final Path guiDir;
    private final String gatewayOrigin;
    private final java.util.function.Supplier<String> adminSecret;
    private final java.util.Map<String, Long> loginNonces = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.security.SecureRandom random = new java.security.SecureRandom();
    private final HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();
    private HttpServer server;

    public GuiServer(Path guiDir, int gatewayPort, java.util.function.Supplier<String> adminSecret) {
        this.guiDir = guiDir;
        this.gatewayOrigin = "http://127.0.0.1:" + gatewayPort;
        this.adminSecret = adminSecret;
    }

    public void start(String bindAddress, int port) throws IOException {
        server = HttpServer.create(new InetSocketAddress(bindAddress, port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", this::handle);
        server.start();
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    /** Actually bound port, so a test can start on an ephemeral one. */
    int boundPort() {
        return server == null ? -1 : server.getAddress().getPort();
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            if ("/desktop-login".equals(path)) {
                handleDesktopLogin(exchange);
                return;
            }
            if ("/manual".equals(path)) {
                handleManual(exchange);
                return;
            }
            if (path.startsWith("/desktop-api/")) {
                handleDesktopApi(exchange, path);
                return;
            }
            String prefix = path.indexOf('/', 1) > 0 ? path.substring(0, path.indexOf('/', 1)) : path;
            if (PROXY_PREFIXES.contains(prefix)) {
                proxy(exchange);
            } else {
                serveStatic(exchange, path);
            }
        } catch (Exception e) {
            sendError(exchange, 502, "{\"error\":\"gateway unreachable\"}");
        } finally {
            exchange.close();
        }
    }

    /**
     * One-click Studio login. The tray mints a single-use, 60s nonce and opens
     * /desktop-login?once=… — this handler exchanges the admin secret for a JWT
     * SERVER-SIDE (the secret never reaches the browser) and serves a tiny page
     * that seeds the GUI's own localStorage auth contract, then enters the app.
     */
    private DesktopConfig desktopConfig;
    private Runnable masterRestarter;

    /** Turns on the Desktop-Lite settings API (absent = 404, so the Studio card hides). */
    public void enableDesktopApi(DesktopConfig config, Runnable masterRestarter) {
        this.desktopConfig = config;
        this.masterRestarter = masterRestarter;
    }

    /**
     * Desktop-Lite settings API for the Studio Settings card. Loopback Host
     * check + the caller's gateway JWT (validated by replaying it against an
     * authenticated gateway route — the launcher holds no JWKS code of its own).
     */
    private void handleDesktopApi(HttpExchange exchange, String path) throws IOException, InterruptedException {
        String host = exchange.getRequestHeaders().getFirst("Host");
        if (desktopConfig == null
            || host == null || !(host.startsWith("localhost") || host.startsWith("127.0.0.1"))) {
            sendError(exchange, 404, "{\"error\":\"not found\"}");
            return;
        }
        String auth = exchange.getRequestHeaders().getFirst("Authorization");
        if (auth == null || !auth.startsWith("Bearer ") || !gatewayAccepts(auth)) {
            sendError(exchange, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        if (!"/desktop-api/llm-settings".equals(path)) {
            sendError(exchange, 404, "{\"error\":\"not found\"}");
            return;
        }
        if ("GET".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 200, llmSettingsJson());
        } else if ("POST".equals(exchange.getRequestMethod())) {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String error = applyLlmSettings(body);
            if (error != null) {
                sendError(exchange, 400, "{\"error\":\"" + error + "\"}");
                return;
            }
            sendJson(exchange, 200, "{\"ok\":true,\"restarting\":\"master\"}");
            Thread.ofVirtual().start(masterRestarter);
        } else {
            sendError(exchange, 405, "{\"error\":\"method not allowed\"}");
        }
    }

    private boolean gatewayAccepts(String authorizationHeader) throws IOException, InterruptedException {
        HttpResponse<Void> probe = client.send(
            HttpRequest.newBuilder(URI.create(gatewayOrigin + "/node-api/admin/models"))
                .header("Authorization", authorizationHeader)
                .timeout(Duration.ofSeconds(5)).GET().build(),
            HttpResponse.BodyHandlers.discarding());
        return probe.statusCode() == 200;
    }

    private String llmSettingsJson() {
        String key = desktopConfig.setting("anthropic.api.key", "");
        String masked = key.isEmpty() ? ""
            : key.length() <= 12 ? "•••"
            : key.substring(0, 7) + "…" + key.substring(key.length() - 4);
        return """
            {"provider":"%s","ollamaBaseUrl":"%s","ollamaModel":"%s",
             "lowModel":"%s","mediumModel":"%s","highModel":"%s","thinkingModel":"%s",
             "anthropicKeyMasked":"%s"}
            """.formatted(
                desktopConfig.setting("llm.provider", "disabled"),
                desktopConfig.setting("ollama.base.url", ""),
                desktopConfig.setting("ollama.model", ""),
                desktopConfig.setting("ollama.low.model", ""),
                desktopConfig.setting("ollama.medium.model", ""),
                desktopConfig.setting("ollama.high.model", ""),
                desktopConfig.setting("ollama.thinking.model", ""),
                masked);
    }

    /** Returns an error message, or null when the settings were applied. */
    private String applyLlmSettings(String body) {
        String provider = jsonString(body, "provider");
        if (!java.util.List.of("disabled", "ollama", "claude").contains(provider)) {
            return "provider must be disabled, ollama or claude";
        }
        String anthropicKey = jsonString(body, "anthropicKey");
        if ("claude".equals(provider) && anthropicKey.isEmpty()
            && desktopConfig.setting("anthropic.api.key", "").isEmpty()) {
            return "claude needs an Anthropic API key";
        }
        String baseUrl = jsonString(body, "ollamaBaseUrl");
        if (!baseUrl.isEmpty() && !baseUrl.startsWith("http")) {
            return "ollama base URL must start with http";
        }
        java.util.Map<String, String> updates = new java.util.LinkedHashMap<>();
        updates.put("llm.provider", provider);
        updates.put("ollama.base.url", baseUrl);
        updates.put("ollama.model", jsonString(body, "ollamaModel"));
        updates.put("ollama.low.model", jsonString(body, "lowModel"));
        updates.put("ollama.medium.model", jsonString(body, "mediumModel"));
        updates.put("ollama.high.model", jsonString(body, "highModel"));
        updates.put("ollama.thinking.model", jsonString(body, "thinkingModel"));
        if (!anthropicKey.isEmpty()) {
            updates.put("anthropic.api.key", anthropicKey); // blank never wipes a stored key
        }
        try {
            desktopConfig.updateSettings(updates);
            return null;
        } catch (IOException e) {
            return "could not write settings: " + e.getMessage();
        }
    }

    private static String jsonString(String body, String field) {
        java.util.regex.Matcher m = java.util.regex.Pattern
            .compile("\"" + java.util.regex.Pattern.quote(field) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
            .matcher(body);
        return m.find() ? m.group(1).replace("\\\"", "\"").replace("\\\\", "\\").trim() : "";
    }

    private void sendJson(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    public String createLoginPath() {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        String nonce = java.util.HexFormat.of().formatHex(bytes);
        long now = System.currentTimeMillis();
        loginNonces.values().removeIf(expiry -> expiry < now);
        loginNonces.put(nonce, now + 60_000);
        return "/desktop-login?once=" + nonce;
    }

    private void handleDesktopLogin(HttpExchange exchange) throws IOException {
        // DNS-rebinding guard: a hostile page can make the browser request an
        // attacker hostname that resolves to 127.0.0.1 — the Host header betrays it
        String host = exchange.getRequestHeaders().getFirst("Host");
        String query = exchange.getRequestURI().getQuery();
        String nonce = null;
        String target = "/";
        for (String param : query == null ? new String[0] : query.split("&")) {
            if (param.startsWith("once=")) {
                nonce = param.substring(5);
            } else if (param.startsWith("to=")) {
                String decoded = java.net.URLDecoder.decode(param.substring(3), StandardCharsets.UTF_8);
                if (decoded.matches("/#/[A-Za-z0-9/_-]*")) {
                    target = decoded; // hash routes only — never an external redirect
                }
            }
        }
        boolean localHost = host != null
            && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
        Long expiry = nonce == null ? null : loginNonces.remove(nonce);
        if (!localHost || expiry == null || expiry < System.currentTimeMillis()) {
            sendError(exchange, 403, "{\"error\":\"invalid or expired login link — use the tray menu\"}");
            return;
        }

        String form = "grant_type=client_credentials&client_id=agenticos-admin&client_secret="
            + java.net.URLEncoder.encode(adminSecret.get(), StandardCharsets.UTF_8);
        HttpResponse<String> token;
        try {
            token = client.send(HttpRequest.newBuilder(URI.create(gatewayOrigin + "/oauth2/token"))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .timeout(Duration.ofSeconds(10))
                    .POST(HttpRequest.BodyPublishers.ofString(form)).build(),
                HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("token exchange interrupted", e);
        }
        java.util.regex.Matcher jwt = java.util.regex.Pattern
            .compile("\"access_token\"\\s*:\\s*\"([^\"]+)\"").matcher(token.body());
        java.util.regex.Matcher ttl = java.util.regex.Pattern
            .compile("\"expires_in\"\\s*:\\s*(\\d+)").matcher(token.body());
        if (token.statusCode() != 200 || !jwt.find() || !ttl.find()) {
            sendError(exchange, 502, "{\"error\":\"gateway login failed\"}");
            return;
        }

        // Seeds the exact localStorage contract of the GUI's AuthService +
        // auth-boundary (jwt, epoch-ms expiry, and BOTH trusted origins — without
        // the origins the bearer is silently never attached).
        String page = """
            <!doctype html><meta charset="utf-8"><title>AgenticNetOS</title>
            <body style="font-family:system-ui;padding:2rem">Signing in to Studio…
            <script>
              localStorage.setItem('agenticos_jwt', '%s');
              localStorage.setItem('agenticos_jwt_expiry', String(Date.now() + %s * 1000));
              localStorage.setItem('agenticos_auth_app_origin', location.origin);
              localStorage.setItem('agenticos_auth_gateway_origin',
                'http://' + location.hostname + ':8083');
              location.replace('%s');
            </script>
            """.formatted(jwt.group(1), ttl.group(1), target);
        byte[] bytes = page.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    /**
     * The newcomer manual, bundled in the launcher jar rather than in the GUI
     * bundle: it documents THIS app, so it must version with it and stay
     * readable while the services are still booting (or failing to).
     */
    private void handleManual(HttpExchange exchange) throws IOException {
        byte[] page = manualPage();
        if (page == null) {
            sendError(exchange, 404, "{\"error\":\"manual not bundled\"}");
            return;
        }
        exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
        exchange.sendResponseHeaders(200, page.length);
        if (!"HEAD".equals(exchange.getRequestMethod())) {
            exchange.getResponseBody().write(page);
        }
    }

    /** Returns the rendered manual, or null when the resource is missing. */
    byte[] manualPage() throws IOException {
        try (InputStream in = GuiServer.class.getResourceAsStream("/manual.html")) {
            if (in == null) {
                return null;
            }
            String version = desktopConfig == null ? "" : desktopConfig.version();
            return new String(in.readAllBytes(), StandardCharsets.UTF_8)
                .replace("__VERSION__", version)
                .getBytes(StandardCharsets.UTF_8);
        }
    }

    private void proxy(HttpExchange exchange) throws IOException, InterruptedException {
        URI target = URI.create(gatewayOrigin + exchange.getRequestURI().toString());
        HttpRequest.Builder builder = HttpRequest.newBuilder(target)
            .timeout(Duration.ofMinutes(10));

        exchange.getRequestHeaders().forEach((name, values) -> {
            if (!SKIP_REQUEST_HEADERS.contains(name.toLowerCase(Locale.ROOT))) {
                values.forEach(v -> builder.header(name, v));
            }
        });

        String method = exchange.getRequestMethod();
        if ("GET".equals(method) || "HEAD".equals(method)) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            byte[] body = exchange.getRequestBody().readAllBytes();
            builder.method(method, HttpRequest.BodyPublishers.ofByteArray(body));
        }

        HttpResponse<InputStream> response =
            client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());

        response.headers().map().forEach((name, values) -> {
            if (!SKIP_RESPONSE_HEADERS.contains(name.toLowerCase(Locale.ROOT)) && !name.startsWith(":")) {
                values.forEach(v -> exchange.getResponseHeaders().add(name, v));
            }
        });

        // length 0 = chunked: required for SSE streams, fine for everything else
        exchange.sendResponseHeaders(response.statusCode(), 0);
        try (InputStream in = response.body(); OutputStream out = exchange.getResponseBody()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                out.flush();
            }
        }
    }

    private void serveStatic(HttpExchange exchange, String rawPath) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod()) && !"HEAD".equals(exchange.getRequestMethod())) {
            sendError(exchange, 405, "{\"error\":\"method not allowed\"}");
            return;
        }
        String path = rawPath.equals("/") ? "/index.html" : rawPath;
        Path file = guiDir.resolve(path.substring(1)).normalize();
        if (!file.startsWith(guiDir) || !Files.isRegularFile(file)) {
            // hash routing means unknown paths are stale links — fall back to the app shell
            file = guiDir.resolve("index.html");
            if (!Files.isRegularFile(file)) {
                sendError(exchange, 404, "{\"error\":\"not found\"}");
                return;
            }
        }
        String name = file.getFileName().toString();
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        String contentType = CONTENT_TYPES.getOrDefault(ext.toLowerCase(Locale.ROOT), "application/octet-stream");
        exchange.getResponseHeaders().set("Content-Type", contentType);
        long size = Files.size(file);
        if ("HEAD".equals(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(200, -1);
            return;
        }
        exchange.sendResponseHeaders(200, size);
        try (OutputStream out = exchange.getResponseBody()) {
            Files.copy(file, out);
        }
    }

    private void sendError(HttpExchange exchange, int status, String body) {
        try {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
        } catch (IOException ignored) {
            // response already committed (e.g. proxy failed mid-stream) — nothing to send
        }
    }
}
