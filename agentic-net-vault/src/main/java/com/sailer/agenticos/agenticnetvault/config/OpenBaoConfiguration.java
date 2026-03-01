package com.sailer.agenticos.agenticnetvault.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.vault.authentication.AppRoleAuthentication;
import org.springframework.vault.authentication.AppRoleAuthenticationOptions;
import org.springframework.vault.authentication.ClientAuthentication;
import org.springframework.vault.authentication.TokenAuthentication;
import org.springframework.vault.client.VaultEndpoint;
import org.springframework.vault.core.VaultTemplate;
import org.springframework.web.client.RestTemplate;

import java.net.URI;

@Configuration
public class OpenBaoConfiguration {

    private static final Logger logger = LoggerFactory.getLogger(OpenBaoConfiguration.class);

    @Bean
    public VaultTemplate vaultTemplate(VaultProperties properties) {
        VaultEndpoint endpoint = VaultEndpoint.from(URI.create(properties.openbaoUrl()));
        ClientAuthentication auth = clientAuthentication(properties, endpoint);
        return new VaultTemplate(endpoint, auth);
    }

    private ClientAuthentication clientAuthentication(VaultProperties properties, VaultEndpoint endpoint) {
        if (properties.approle() != null && properties.approle().isConfigured()) {
            logger.info("Using AppRole authentication for OpenBao");
            AppRoleAuthenticationOptions options = AppRoleAuthenticationOptions.builder()
                .roleId(AppRoleAuthenticationOptions.RoleId.provided(properties.approle().roleId()))
                .secretId(AppRoleAuthenticationOptions.SecretId.provided(properties.approle().secretId()))
                .build();
            RestTemplate restTemplate = new RestTemplate();
            return new AppRoleAuthentication(options, restTemplate);
        }

        logger.info("Using token authentication for OpenBao at {}", properties.openbaoUrl());
        return new TokenAuthentication(properties.openbaoToken());
    }
}
