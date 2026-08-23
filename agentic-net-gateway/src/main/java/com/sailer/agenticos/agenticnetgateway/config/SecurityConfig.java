package com.sailer.agenticos.agenticnetgateway.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;

import java.util.Arrays;
import java.util.List;

/**
 * Spring Security filter chain — stateless JWT resource server.
 *
 * Public endpoints:
 *   /oauth2/**              — Token issuance and JWKS
 *   /actuator/**            — Health and metrics
 *   /api/health/**          — Service health checks
 *   GET /api/hub/public/**  — NetHub public catalog (ONLY when gateway.hub.public-catalog=true)
 *   GET /api/packages/**    — Package browsing (ONLY when gateway.hub.public-catalog=true)
 *   POST /oauth2/share      — Read-only net share-link exchange (ONLY when gateway.share-enabled=true).
 *                             Trades a link uuid for a share-scoped JWT; opens nothing under /api.
 *   /internal/masters/**    — Shared-secret protected master registry
 *
 * With gateway.hub.public-catalog=false (the default), NOTHING under /api is anonymous:
 * every request needs a JWT ("no token ⇒ nothing").
 *
 * Protected endpoints (JWT required):
 *   /api/**                 — Master API (proxied)
 *   /node-api/**            — Node API (proxied)
 *   /vault-api/**           — Vault API (proxied)
 *   /api/docker/**          — Docker container management
 *   /api/registry/**        — Docker registry management
 *   /api/transitions/**     — Executor polling and control
 *   POST/PUT/DELETE /api/packages/** — Package mutations
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final TokenRateLimiter tokenRateLimiter;
    private final ReadonlyEnforcementFilter readonlyEnforcementFilter;
    private final ExecutorScopeEnforcementFilter executorScopeEnforcementFilter;
    private final ShareScopeEnforcementFilter shareScopeEnforcementFilter;
    private final List<String> allowedOriginPatterns;
    private final boolean hubPublicCatalog;
    private final boolean shareEnabled;

    public SecurityConfig(TokenRateLimiter tokenRateLimiter,
                          ReadonlyEnforcementFilter readonlyEnforcementFilter,
                          ExecutorScopeEnforcementFilter executorScopeEnforcementFilter,
                          ShareScopeEnforcementFilter shareScopeEnforcementFilter,
                          @Value("${gateway.cors.allowed-origin-patterns:http://localhost:*,http://127.0.0.1:*}") String allowedOriginPatterns,
                          @Value("${gateway.hub.public-catalog:false}") boolean hubPublicCatalog,
                          // NOTE the kebab key: this binds to GatewayProperties.shareEnabled too,
                          // so the filter chain and ShareExchangeController cannot disagree.
                          // (gateway.hub.public-catalog above does NOT bind to its GatewayProperties
                          // field — that getter is dead. Do not copy that shape.)
                          @Value("${gateway.share-enabled:false}") boolean shareEnabled) {
        this.tokenRateLimiter = tokenRateLimiter;
        this.readonlyEnforcementFilter = readonlyEnforcementFilter;
        this.executorScopeEnforcementFilter = executorScopeEnforcementFilter;
        this.shareScopeEnforcementFilter = shareScopeEnforcementFilter;
        this.allowedOriginPatterns = parseCsv(allowedOriginPatterns);
        this.hubPublicCatalog = hubPublicCatalog;
        this.shareEnabled = shareEnabled;
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
                .addFilterBefore(tokenRateLimiter, UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(readonlyEnforcementFilter, BearerTokenAuthenticationFilter.class)
                .addFilterAfter(executorScopeEnforcementFilter, ReadonlyEnforcementFilter.class)
                .addFilterAfter(shareScopeEnforcementFilter, ExecutorScopeEnforcementFilter.class)
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> {
                        auth
                        .requestMatchers("/oauth2/token").permitAll()
                        .requestMatchers("/oauth2/jwks").permitAll()
                        .requestMatchers("/actuator/**").permitAll()
                        .requestMatchers("/api/health/**").permitAll();
                        // Opt-in public hub: anonymous GET of the NetHub public catalog + package
                        // browse. OFF by default (must precede the /api/** catch-all to take effect).
                        if (hubPublicCatalog) {
                            auth.requestMatchers(HttpMethod.GET, "/api/hub/public/**").permitAll()
                                .requestMatchers(HttpMethod.GET, "/api/packages/**").permitAll();
                        }
                        // Opt-in read-only net share links. Only the EXCHANGE is anonymous: it
                        // trades the link uuid for a share-scoped JWT, after which
                        // ShareScopeEnforcementFilter constrains every call. Nothing under
                        // /api/** is opened up. OFF by default.
                        if (shareEnabled) {
                            auth.requestMatchers(HttpMethod.POST, "/oauth2/share").permitAll();
                        } else {
                            // Keep management in lockstep with exchange. Otherwise an operator
                            // can create a stored link that is guaranteed to be dead on arrival.
                            auth.requestMatchers("/api/shares", "/api/shares/**").denyAll();
                        }
                        auth
                        // All other /api/** endpoints require JWT authentication
                        .requestMatchers("/api/**").authenticated()
                        .requestMatchers("/node-api/**").authenticated()
                        .requestMatchers("/vault-api/**").authenticated()
                        .requestMatchers("/internal/masters/**").permitAll()
                        .anyRequest().denyAll();
                })
                .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))
                .cors(cors -> cors.configurationSource(req -> {
                    var c = new CorsConfiguration();
                    c.setAllowedOriginPatterns(allowedOriginPatterns);
                    c.setAllowedMethods(List.of("*"));
                    c.setAllowedHeaders(List.of("*"));
                    return c;
                }))
                .build();
    }

    private List<String> parseCsv(String value) {
        return Arrays.stream(value.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }
}
