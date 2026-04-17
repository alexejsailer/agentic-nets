package com.sailer.agenticos.agenticnetvault.service;

import com.sailer.agenticos.agenticnetvault.service.VersionService.VersionReadException;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Verifies that {@link VersionService} reads the version directly from the
 * real {@code pom.xml} on the filesystem. This guarantees the endpoint
 * reports the same version that is declared in the build.
 */
class VersionServiceTest {

    @Test
    void readVersion_returnsProjectVersionFromPomXml() {
        VersionService service = new VersionService();

        String version = service.readVersion();

        // Must match the <version> directly under <project>, not the parent Spring Boot version.
        assertThat(version).isNotBlank();
        assertThat(version).doesNotContain("<");
        assertThat(version).isNotEqualTo("3.5.5"); // parent version must not leak through
    }

    @Test
    void readVersion_matchesPomXmlExactly() throws Exception {
        // Read pom.xml ourselves and confirm VersionService picks the same value.
        String pom = java.nio.file.Files.readString(java.nio.file.Path.of("pom.xml"));
        String expected = extractProjectVersion(pom);

        String actual = new VersionService().readVersion();

        assertThat(actual).isEqualTo(expected);
    }

    /** Extract the first <version> after <artifactId>agentic-net-vault</artifactId>. */
    private String extractProjectVersion(String pom) {
        int artifactIdx = pom.indexOf("<artifactId>agentic-net-vault</artifactId>");
        assertThat(artifactIdx).as("artifactId must be present in pom.xml").isGreaterThan(0);
        int versionStart = pom.indexOf("<version>", artifactIdx);
        int versionEnd = pom.indexOf("</version>", versionStart);
        assertThat(versionStart).isGreaterThan(0);
        assertThat(versionEnd).isGreaterThan(versionStart);
        return pom.substring(versionStart + "<version>".length(), versionEnd).trim();
    }

    @Test
    void versionReadException_carriesMessageAndCause() {
        Exception cause = new RuntimeException("underlying");
        VersionReadException e = new VersionReadException("boom", cause);

        assertThatThrownBy(() -> { throw e; })
            .isInstanceOf(VersionReadException.class)
            .hasMessage("boom")
            .hasCause(cause);
    }
}
