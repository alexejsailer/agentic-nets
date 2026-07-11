package com.sailer.agenticos.agenticnetgateway.config;

import io.netty.resolver.DefaultAddressResolverGroup;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.netty.http.client.HttpClient;

/**
 * WebClient factory for gateway→service traffic inside Docker networks.
 *
 * <p>Reactor-Netty's default DNS resolver caches lookups honoring the DNS record's TTL — and
 * Docker's embedded DNS hands out a 600s TTL. After {@code docker compose up -d <service>}
 * recreates a container with a new IP, a default WebClient keeps connecting to the DEAD
 * address for up to 10 minutes (observed live: the gateway black-holed a freshly recreated
 * master with "Connection refused" to its old IP while Docker DNS already served the new
 * one). The JDK resolver caches positive lookups for ~30s, so recreated containers become
 * reachable again within seconds. Every proxy client must be built through this factory.</p>
 */
public final class ProxyWebClients {

    private ProxyWebClients() {
    }

    /** A WebClient.Builder whose connector re-resolves DNS with the JDK resolver (~30s cache). */
    public static WebClient.Builder builder() {
        return WebClient.builder()
                .clientConnector(new ReactorClientHttpConnector(
                        HttpClient.create().resolver(DefaultAddressResolverGroup.INSTANCE)));
    }
}
