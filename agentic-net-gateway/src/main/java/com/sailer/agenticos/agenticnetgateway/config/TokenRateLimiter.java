package com.sailer.agenticos.agenticnetgateway.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Instant;
import java.util.Arrays;
import java.util.Deque;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Simple in-memory IP-based rate limiter for the credential-bearing endpoints.
 * Uses a sliding window of 1 minute per IP address.
 *
 * <p>Covers {@code POST /oauth2/token} and {@code POST /oauth2/share}. The share exchange is
 * included because it is the one anonymous route in the gateway: without a limit it would be a
 * free brute-force oracle against link uuids and an unthrottled amplification path into
 * master.</p>
 */
@Component
public class TokenRateLimiter extends OncePerRequestFilter {

    private static final Logger logger = LoggerFactory.getLogger(TokenRateLimiter.class);
    private static final long WINDOW_SECONDS = 60;

    private final GatewayProperties props;
    private final ConcurrentHashMap<String, Deque<Instant>> requestLog = new ConcurrentHashMap<>();

    public TokenRateLimiter(GatewayProperties props) {
        this.props = props;
        // Evict stale entries every 5 minutes to prevent memory leak
        Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "rate-limiter-cleanup");
            t.setDaemon(true);
            return t;
        }).scheduleAtFixedRate(this::evictStaleEntries, 5, 5, TimeUnit.MINUTES);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!"POST".equalsIgnoreCase(request.getMethod())) {
            return true;
        }
        String uri = GatewayRequestPaths.effectivePath(request);
        if (uri == null) {
            return true;
        }
        // Normalise a trailing slash so a framework default (optional trailing-slash matching) can
        // never route /oauth2/token/ to the controller while the limiter looks the other way.
        if (uri.length() > 1 && uri.endsWith("/")) {
            uri = uri.substring(0, uri.length() - 1);
        }
        return !("/oauth2/token".equals(uri) || "/oauth2/share".equals(uri));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String ip = getClientIp(request);
        int limit = props.getRateLimitPerMinute();

        Deque<Instant> timestamps = requestLog.computeIfAbsent(ip, k -> new ConcurrentLinkedDeque<>());
        Instant now = Instant.now();
        Instant windowStart = now.minusSeconds(WINDOW_SECONDS);

        // Remove expired entries from the front of the deque
        while (!timestamps.isEmpty() && timestamps.peekFirst().isBefore(windowStart)) {
            timestamps.pollFirst();
        }

        if (timestamps.size() >= limit) {
            logger.warn("Rate limit exceeded for IP={} ({}/{})", ip, timestamps.size(), limit);
            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader("Retry-After", "60");
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"rate_limit_exceeded\"}");
            return;
        }

        timestamps.addLast(now);
        filterChain.doFilter(request, response);
    }

    private String getClientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank() && isTrustedProxy(request.getRemoteAddr())) {
            return xff.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    private boolean isTrustedProxy(String remoteAddr) {
        String trusted = props.getTrustedProxies();
        if (trusted == null || trusted.isBlank()) return false;
        return Arrays.stream(trusted.split(","))
                .map(String::trim)
                .filter(t -> !t.isEmpty())
                .anyMatch(t -> t.equals(remoteAddr) || cidrContains(t, remoteAddr));
    }

    /**
     * CIDR match (e.g. {@code 172.16.0.0/12} for the Docker bridge a host reverse proxy arrives
     * from), so the per-client window is keyed on X-Forwarded-For behind a proxy instead of
     * collapsing every public user into one bucket.
     */
    static boolean cidrContains(String cidr, String address) {
        int slash = cidr.indexOf('/');
        if (slash < 0) return false;
        try {
            byte[] net = java.net.InetAddress.getByName(cidr.substring(0, slash)).getAddress();
            byte[] addr = java.net.InetAddress.getByName(address).getAddress();
            int bits = Integer.parseInt(cidr.substring(slash + 1));
            if (net.length != addr.length || bits < 0 || bits > net.length * 8) return false;
            for (int i = 0; i < net.length; i++) {
                int remaining = bits - i * 8;
                if (remaining <= 0) return true;
                int mask = remaining >= 8 ? 0xFF : (0xFF << (8 - remaining)) & 0xFF;
                if ((net[i] & mask) != (addr[i] & mask)) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void evictStaleEntries() {
        Instant cutoff = Instant.now().minusSeconds(WINDOW_SECONDS);
        Iterator<Map.Entry<String, Deque<Instant>>> it = requestLog.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Deque<Instant>> entry = it.next();
            Deque<Instant> timestamps = entry.getValue();
            while (!timestamps.isEmpty() && timestamps.peekFirst().isBefore(cutoff)) {
                timestamps.pollFirst();
            }
            if (timestamps.isEmpty()) {
                it.remove();
            }
        }
    }
}
