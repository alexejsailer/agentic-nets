package com.sailer.agenticos.agenticnetgateway.rest;

import com.sailer.agenticos.agenticnetgateway.config.ProxyWebClients;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService;
import com.sailer.agenticos.agenticnetgateway.service.MasterRegistryService.MasterNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fleet-wide LLM kill switch. One request here fans out to every registered master's
 * {@code /api/system/llm-freeze} endpoint, so an operator can freeze/thaw the whole deployment
 * from one place. This is deliberately NOT the model-routed proxy ({@code /api/**}): freezing
 * has to reach ALL masters, not just the one that owns a given model.
 *
 * <ul>
 *   <li>{@code GET  /api/system/llm-freeze/fleet} — per-master state + an aggregate summary</li>
 *   <li>{@code POST /api/system/llm-freeze/fleet} — forward {@code {frozen,reason,by}} to every master</li>
 * </ul>
 *
 * Both require JWT (the {@code /api/**} rule); a POST additionally needs a non-readonly token
 * (the readonly enforcement filter blocks writes), so only admin can freeze.
 */
@RestController
@RequestMapping("/api/system")
public class SystemControlController {

    private static final Logger logger = LoggerFactory.getLogger(SystemControlController.class);
    private static final String MASTER_PATH = "/api/system/llm-freeze";
    private static final Duration TIMEOUT = Duration.ofSeconds(5);

    private final MasterRegistryService registry;
    private final ConcurrentHashMap<String, WebClient> clients = new ConcurrentHashMap<>();

    public SystemControlController(MasterRegistryService registry) {
        this.registry = registry;
    }

    private WebClient client(String baseUrl) {
        return clients.computeIfAbsent(baseUrl, url -> ProxyWebClients.builder().baseUrl(url).build());
    }

    @GetMapping("/llm-freeze/fleet")
    public Mono<Map<String, Object>> fleetState() {
        List<MasterNode> masters = registry.getActiveMasters();
        return Flux.fromIterable(masters)
                .flatMap(m -> client(m.url()).get().uri(MASTER_PATH)
                        .retrieve()
                        .bodyToMono(MAP)
                        .timeout(TIMEOUT)
                        .map(state -> row(m, state, true, null))
                        .onErrorResume(e -> Mono.just(row(m, Map.of(), false, e.getMessage()))))
                .collectList()
                .map(SystemControlController::aggregate);
    }

    @PostMapping("/llm-freeze/fleet")
    public Mono<Map<String, Object>> fleetSet(@RequestBody Map<String, Object> body) {
        List<MasterNode> masters = registry.getActiveMasters();
        logger.info("Fleet LLM freeze request: frozen={} across {} master(s)", body.get("frozen"), masters.size());
        return Flux.fromIterable(masters)
                .flatMap(m -> client(m.url()).post().uri(MASTER_PATH)
                        .bodyValue(body)
                        .retrieve()
                        .bodyToMono(MAP)
                        .timeout(TIMEOUT)
                        .map(state -> row(m, state, true, null))
                        .onErrorResume(e -> {
                            logger.warn("Fleet freeze: master {} ({}) failed: {}", m.masterId(), m.url(), e.getMessage());
                            return Mono.just(row(m, Map.of(), false, e.getMessage()));
                        }))
                .collectList()
                .map(SystemControlController::aggregate);
    }

    private static final org.springframework.core.ParameterizedTypeReference<Map<String, Object>> MAP =
            new org.springframework.core.ParameterizedTypeReference<>() {};

    private static Map<String, Object> row(MasterNode m, Map<String, Object> state, boolean reachable, String error) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("masterId", m.masterId());
        r.put("url", m.url());
        r.put("reachable", reachable);
        r.put("frozen", Boolean.TRUE.equals(state.get("frozen")));
        r.put("reason", state.getOrDefault("reason", ""));
        r.put("by", state.getOrDefault("by", ""));
        r.put("at", state.getOrDefault("at", ""));
        r.put("autoFreezeThreshold", asLong(state.get("autoFreezeThreshold")));
        r.put("tokensLast24h", asLong(state.get("tokensLast24h")));
        if (error != null) {
            r.put("error", error);
        }
        return r;
    }

    private static long asLong(Object v) {
        if (v instanceof Number n) return n.longValue();
        try {
            return (v == null) ? 0L : Long.parseLong(String.valueOf(v).trim());
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> aggregate(List<Map<String, Object>> rows) {
        long reachable = rows.stream().filter(r -> Boolean.TRUE.equals(r.get("reachable"))).count();
        long frozenCount = rows.stream()
                .filter(r -> Boolean.TRUE.equals(r.get("reachable")) && Boolean.TRUE.equals(r.get("frozen")))
                .count();
        long tokensLast24h = rows.stream()
                .filter(r -> Boolean.TRUE.equals(r.get("reachable")))
                .mapToLong(r -> asLong(r.get("tokensLast24h"))).sum();
        // Threshold is set fleet-wide; surface the max seen so a partially-applied change is visible.
        long threshold = rows.stream()
                .filter(r -> Boolean.TRUE.equals(r.get("reachable")))
                .mapToLong(r -> asLong(r.get("autoFreezeThreshold"))).max().orElse(0L);

        Map<String, Object> out = new LinkedHashMap<>();
        // Fleet counts as frozen only when every reachable master is frozen (and at least one exists).
        out.put("frozen", reachable > 0 && frozenCount == reachable);
        out.put("total", rows.size());
        out.put("reachable", reachable);
        out.put("frozenCount", frozenCount);
        out.put("autoFreezeThreshold", threshold);
        out.put("tokensLast24h", tokensLast24h);
        out.put("masters", rows);
        return out;
    }
}
