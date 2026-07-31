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

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            if ("/desktop-login".equals(path)) {
                handleDesktopLogin(exchange);
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
        String nonce = query != null && query.startsWith("once=") ? query.substring(5) : null;
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
              location.replace('/');
            </script>
            """.formatted(jwt.group(1), ttl.group(1));
        byte[] bytes = page.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
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
