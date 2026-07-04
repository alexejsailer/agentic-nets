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
    private final List<String> allowedOriginPatterns;
    private final boolean hubPublicCatalog;

    public SecurityConfig(TokenRateLimiter tokenRateLimiter,
                          ReadonlyEnforcementFilter readonlyEnforcementFilter,
                          @Value("${gateway.cors.allowed-origin-patterns:http://localhost:*,http://127.0.0.1:*}") String allowedOriginPatterns,
                          @Value("${gateway.hub.public-catalog:false}") boolean hubPublicCatalog) {
        this.tokenRateLimiter = tokenRateLimiter;
        this.readonlyEnforcementFilter = readonlyEnforcementFilter;
        this.allowedOriginPatterns = parseCsv(allowedOriginPatterns);
        this.hubPublicCatalog = hubPublicCatalog;
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
                .addFilterBefore(tokenRateLimiter, UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(readonlyEnforcementFilter, BearerTokenAuthenticationFilter.class)
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
