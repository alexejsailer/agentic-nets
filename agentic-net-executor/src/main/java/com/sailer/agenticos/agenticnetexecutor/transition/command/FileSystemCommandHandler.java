package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Base64;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Command handler for filesystem operations.
 *
 * Supported commands:
 * - readFile: Read file content (text or binary)
 * - writeFile: Write content to file
 * - listDir: List directory contents
 * - exists: Check if path exists
 * - mkdir: Create directory
 * - delete: Delete file or directory
 * - stat: Get file/directory metadata
 */
@Component
public class FileSystemCommandHandler implements CommandHandler {

    private static final Logger logger = LoggerFactory.getLogger(FileSystemCommandHandler.class);
    private static final String EXECUTOR_TYPE = "fs";

    private static final Set<String> SUPPORTED_COMMANDS = Set.of(
            "readFile", "writeFile", "listDir", "exists", "mkdir", "delete", "stat"
    );

    private final ObjectMapper objectMapper;

    public FileSystemCommandHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public String getExecutorType() {
        return EXECUTOR_TYPE;
    }

    @Override
    public Set<String> getSupportedCommands() {
        return SUPPORTED_COMMANDS;
    }

    @Override
    public CommandResult execute(CommandToken token) {
        long startTime = System.currentTimeMillis();

        try {
            JsonNode output = switch (token.command()) {
                case "readFile" -> executeReadFile(token.args());
                case "writeFile" -> executeWriteFile(token.args());
                case "listDir" -> executeListDir(token.args());
                case "exists" -> executeExists(token.args());
                case "mkdir" -> executeMkdir(token.args());
                case "delete" -> executeDelete(token.args());
                case "stat" -> executeStat(token.args());
                default -> throw new IllegalArgumentException("Unknown command: " + token.command());
            };

            long durationMs = System.currentTimeMillis() - startTime;
            logger.debug("Command {}:{} completed in {}ms", token.executor(), token.command(), durationMs);
            return CommandResult.success(token.id(), output, durationMs, token.getMetaAsMap());

        } catch (Exception e) {
            long durationMs = System.currentTimeMillis() - startTime;
            logger.error("Command {}:{} failed: {}", token.executor(), token.command(), e.getMessage());
            return CommandResult.failed(token.id(), e.getMessage(), durationMs, token.getMetaAsMap());
        }
    }

    private JsonNode executeReadFile(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        String encoding = getString(args, "encoding", "utf-8");
        boolean binary = getBoolean(args, "binary", false);

        Path path = Path.of(pathStr);
        ObjectNode result = objectMapper.createObjectNode();

        if (binary) {
            byte[] bytes = Files.readAllBytes(path);
            result.put("content", Base64.getEncoder().encodeToString(bytes));
            result.put("encoding", "base64");
            result.put("size", bytes.length);
        } else {
            Charset charset = Charset.forName(encoding);
            String content = Files.readString(path, charset);
            result.put("content", content);
            result.put("encoding", encoding);
            result.put("size", content.length());
        }

        result.put("path", pathStr);
        return result;
    }

    private JsonNode executeWriteFile(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        String content = getRequiredString(args, "content");
        String encoding = getString(args, "encoding", "utf-8");
        boolean append = getBoolean(args, "append", false);
        boolean binary = getBoolean(args, "binary", false);
        boolean createDirs = getBoolean(args, "createDirs", true);

        Path path = Path.of(pathStr);

        if (createDirs && path.getParent() != null) {
            Files.createDirectories(path.getParent());
        }

        if (binary) {
            byte[] bytes = Base64.getDecoder().decode(content);
            if (append) {
                Files.write(path, bytes, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } else {
                Files.write(path, bytes);
            }
        } else {
            Charset charset = Charset.forName(encoding);
            if (append) {
                Files.writeString(path, content, charset, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } else {
                Files.writeString(path, content, charset);
            }
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", pathStr);
        result.put("written", true);
        result.put("size", Files.size(path));
        return result;
    }

    private JsonNode executeListDir(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        boolean recursive = getBoolean(args, "recursive", false);
        boolean includeHidden = getBoolean(args, "includeHidden", false);

        Path path = Path.of(pathStr);
        ArrayNode entries = objectMapper.createArrayNode();

        try (Stream<Path> stream = recursive ? Files.walk(path) : Files.list(path)) {
            stream
                    .filter(p -> !p.equals(path))
                    .filter(p -> includeHidden || !p.getFileName().toString().startsWith("."))
                    .forEach(p -> {
                        ObjectNode entry = objectMapper.createObjectNode();
                        entry.put("name", p.getFileName().toString());
                        entry.put("path", p.toString());
                        entry.put("isDirectory", Files.isDirectory(p));
                        entry.put("isFile", Files.isRegularFile(p));
                        try {
                            entry.put("size", Files.isRegularFile(p) ? Files.size(p) : 0);
                        } catch (IOException e) {
                            entry.put("size", -1);
                        }
                        entries.add(entry);
                    });
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", pathStr);
        result.set("entries", entries);
        result.put("count", entries.size());
        return result;
    }

    private JsonNode executeExists(JsonNode args) {
        String pathStr = getRequiredString(args, "path");
        Path path = Path.of(pathStr);

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", pathStr);
        result.put("exists", Files.exists(path));
        result.put("isDirectory", Files.isDirectory(path));
        result.put("isFile", Files.isRegularFile(path));
        result.put("isReadable", Files.isReadable(path));
        result.put("isWritable", Files.isWritable(path));
        return result;
    }

    private JsonNode executeMkdir(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        boolean parents = getBoolean(args, "parents", true);

        Path path = Path.of(pathStr);

        if (parents) {
            Files.createDirectories(path);
        } else {
            Files.createDirectory(path);
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", pathStr);
        result.put("created", true);
        return result;
    }

    private JsonNode executeDelete(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        boolean recursive = getBoolean(args, "recursive", false);

        Path path = Path.of(pathStr);
        boolean existed = Files.exists(path);

        if (existed) {
            if (recursive && Files.isDirectory(path)) {
                // Delete directory recursively
                try (Stream<Path> walk = Files.walk(path)) {
                    walk.sorted((a, b) -> b.compareTo(a)) // Reverse order (children first)
                            .forEach(p -> {
                                try {
                                    Files.delete(p);
                                } catch (IOException e) {
                                    throw new RuntimeException("Failed to delete: " + p, e);
                                }
                            });
                }
            } else {
                Files.delete(path);
            }
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", pathStr);
        result.put("deleted", existed);
        result.put("existed", existed);
        return result;
    }

    private JsonNode executeStat(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        Path path = Path.of(pathStr);

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", pathStr);
        result.put("exists", Files.exists(path));

        if (Files.exists(path)) {
            result.put("isDirectory", Files.isDirectory(path));
            result.put("isFile", Files.isRegularFile(path));
            result.put("isSymbolicLink", Files.isSymbolicLink(path));
            result.put("size", Files.isRegularFile(path) ? Files.size(path) : 0);
            result.put("lastModified", Files.getLastModifiedTime(path).toMillis());
            result.put("isReadable", Files.isReadable(path));
            result.put("isWritable", Files.isWritable(path));
            result.put("isExecutable", Files.isExecutable(path));
        }

        return result;
    }

    // Helper methods for extracting arguments

    private String getRequiredString(JsonNode args, String field) {
        if (args == null || !args.has(field) || args.get(field).isNull()) {
            throw new IllegalArgumentException("Required field '" + field + "' is missing");
        }
        return args.get(field).asText();
    }

    private String getString(JsonNode args, String field, String defaultValue) {
        if (args == null || !args.has(field) || args.get(field).isNull()) {
            return defaultValue;
        }
        return args.get(field).asText(defaultValue);
    }

    private boolean getBoolean(JsonNode args, String field, boolean defaultValue) {
        if (args == null || !args.has(field) || args.get(field).isNull()) {
            return defaultValue;
        }
        return args.get(field).asBoolean(defaultValue);
    }

    @Override
    public boolean supportsConcurrentExecution() {
        return true; // File operations can be parallelized
    }

    @Override
    public int getMaxConcurrency() {
        return 4; // Limit concurrent file operations
    }
}
