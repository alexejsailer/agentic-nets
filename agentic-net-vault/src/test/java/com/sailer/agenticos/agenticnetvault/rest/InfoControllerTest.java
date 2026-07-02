package com.sailer.agenticos.agenticnetvault.rest;

import com.sailer.agenticos.agenticnetvault.rest.InfoController.ServiceInfo;
import com.sailer.agenticos.agenticnetvault.service.VersionService;
import com.sailer.agenticos.agenticnetvault.service.VersionService.VersionReadException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

/**
 * Hermetic unit test for {@link InfoController}.
 *
 * <p>Exercises the identity-document endpoint's two branches: the happy path
 * where {@link VersionService#readVersion()} succeeds, and the fallback path
 * where it throws {@link VersionReadException} and the controller must serve the
 * configured fallback version instead. Uses plain construction + Mockito — no
 * Spring context — so it is fast and fully deterministic.
 */
@ExtendWith(MockitoExtension.class)
class InfoControllerTest {

    private static final String APP_NAME = "agentic-net-vault";
    private static final String FALLBACK_VERSION = "9.9.9-FALLBACK";

    @Mock
    private VersionService versionService;

    private InfoController controller() {
        return new InfoController(versionService, APP_NAME, FALLBACK_VERSION);
    }

    @Test
    void info_returnsOkWithResolvedVersion_onHappyPath() {
        when(versionService.readVersion()).thenReturn("2.16.0");

        ResponseEntity<ServiceInfo> response = controller().info();

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().name()).isEqualTo(APP_NAME);
        assertThat(response.getBody().version()).isEqualTo("2.16.0");
        // The resolved version must win over the configured fallback.
        assertThat(response.getBody().version()).isNotEqualTo(FALLBACK_VERSION);

        verify(versionService, times(1)).readVersion();
        verifyNoMoreInteractions(versionService);
    }

    @Test
    void info_fallsBackToConfiguredVersion_whenReadVersionThrows() {
        when(versionService.readVersion())
            .thenThrow(new VersionReadException("pom.xml not found on classpath or filesystem"));

        ResponseEntity<ServiceInfo> response = controller().info();

        // The failure is swallowed: the endpoint still returns 200 with the fallback.
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().name()).isEqualTo(APP_NAME);
        assertThat(response.getBody().version()).isEqualTo(FALLBACK_VERSION);

        verify(versionService, times(1)).readVersion();
        verifyNoMoreInteractions(versionService);
    }

    @Test
    void info_alwaysReportsConfiguredApplicationName_regardlessOfBranch() {
        InfoController custom = new InfoController(versionService, "custom-service", FALLBACK_VERSION);
        when(versionService.readVersion()).thenReturn("1.0.0");

        ServiceInfo body = custom.info().getBody();

        assertThat(body).isNotNull();
        assertThat(body.name()).isEqualTo("custom-service");
        assertThat(body.version()).isEqualTo("1.0.0");
    }

    @Test
    void info_fallbackBranchUsesTheExactConfiguredFallbackString() {
        InfoController custom = new InfoController(versionService, APP_NAME, "0.0.1-SNAPSHOT");
        when(versionService.readVersion())
            .thenThrow(new VersionReadException("boom", new RuntimeException("cause")));

        ServiceInfo body = custom.info().getBody();

        assertThat(body).isNotNull();
        assertThat(body.version()).isEqualTo("0.0.1-SNAPSHOT");
    }

    @Test
    void serviceInfo_recordExposesConstructorArgumentsVerbatim() {
        ServiceInfo info = new ServiceInfo("svc", "3.2.1");

        assertThat(info.name()).isEqualTo("svc");
        assertThat(info.version()).isEqualTo("3.2.1");
    }
}
