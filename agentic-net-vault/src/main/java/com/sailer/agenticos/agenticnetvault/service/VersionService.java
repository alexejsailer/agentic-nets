package com.sailer.agenticos.agenticnetvault.service;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import java.io.InputStream;

/**
 * Reads the Maven project version directly from the {@code pom.xml} file.
 *
 * <p>Resolution order:
 * <ol>
 *   <li>Classpath at {@code META-INF/maven/{groupId}/{artifactId}/pom.xml}
 *       (available when running from a packaged Spring Boot jar).</li>
 *   <li>Filesystem at {@code ./pom.xml} (available when running via
 *       {@code mvn spring-boot:run} or from the IDE).</li>
 * </ol>
 */
@Service
public class VersionService {

    private static final String GROUP_ID = "com.sailer.agenticos";
    private static final String ARTIFACT_ID = "agentic-net-vault";
    private static final String CLASSPATH_POM =
        "META-INF/maven/" + GROUP_ID + "/" + ARTIFACT_ID + "/pom.xml";
    private static final String FILESYSTEM_POM = "pom.xml";

    /**
     * @return the project version declared in {@code pom.xml}.
     * @throws VersionReadException if the pom.xml cannot be located or parsed.
     */
    public String readVersion() {
        Resource resource = locatePom();
        try (InputStream in = resource.getInputStream()) {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            factory.setNamespaceAware(false);

            DocumentBuilder builder = factory.newDocumentBuilder();
            Document doc = builder.parse(in);
            doc.getDocumentElement().normalize();

            Element project = doc.getDocumentElement();
            String version = findProjectVersion(project);
            if (version == null || version.isBlank()) {
                throw new VersionReadException(
                    "No <version> element found in pom.xml for project " + ARTIFACT_ID);
            }
            return version.trim();
        } catch (VersionReadException e) {
            throw e;
        } catch (Exception e) {
            throw new VersionReadException("Failed to read version from pom.xml: " + e.getMessage(), e);
        }
    }

    private Resource locatePom() {
        Resource classpath = new ClassPathResource(CLASSPATH_POM);
        if (classpath.exists()) {
            return classpath;
        }
        Resource file = new FileSystemResource(FILESYSTEM_POM);
        if (file.exists()) {
            return file;
        }
        throw new VersionReadException(
            "pom.xml not found on classpath (" + CLASSPATH_POM + ") or filesystem (" + FILESYSTEM_POM + ")");
    }

    /**
     * Returns the {@code <version>} child of the project root, ignoring the
     * version nested inside {@code <parent>}.
     */
    private String findProjectVersion(Element project) {
        NodeList children = project.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node node = children.item(i);
            if (node.getNodeType() == Node.ELEMENT_NODE && "version".equals(node.getNodeName())) {
                return node.getTextContent();
            }
        }
        return null;
    }

    /** Thrown when the project version cannot be resolved from pom.xml. */
    public static class VersionReadException extends RuntimeException {
        public VersionReadException(String message) {
            super(message);
        }

        public VersionReadException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
