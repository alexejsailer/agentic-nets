package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Value;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Comparator;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
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
    private final List<Path> allowedRoots;
    private final long maxFileSize;

    public FileSystemCommandHandler(
            ObjectMapper objectMapper,
            @Value("${executor.command.filesystem.allowed-dirs:/workspace,/tmp/executor}") String allowedDirs,
            @Value("${executor.command.filesystem.max-file-size:10485760}") long maxFileSize) {
        this.objectMapper = objectMapper;
        this.allowedRoots = parseAllowedRoots(allowedDirs);
        this.maxFileSize = maxFileSize;

        if (this.allowedRoots.isEmpty()) {
            throw new IllegalStateException("At least one filesystem allowed directory must be configured");
        }
        logger.info("Filesystem command handler restricted to {} with max file size {} bytes",
                this.allowedRoots, this.maxFileSize);
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

        Path path = resolveExistingAllowedPath(pathStr);
        ObjectNode result = objectMapper.createObjectNode();

        if (!Files.isRegularFile(path)) {
            throw new IOException("Path is not a regular file: " + pathStr);
        }

        long size = Files.size(path);
        ensureFileSize(size);

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

        result.put("path", path.toString());
        return result;
    }

    private JsonNode executeWriteFile(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        String content = getRequiredString(args, "content");
        String encoding = getString(args, "encoding", "utf-8");
        boolean append = getBoolean(args, "append", false);
        boolean binary = getBoolean(args, "binary", false);
        boolean createDirs = getBoolean(args, "createDirs", true);

        Charset charset = Charset.forName(encoding);
        Path path = resolveAllowedPathForWrite(pathStr);

        long writeSize;
        if (binary) {
            byte[] bytes = Base64.getDecoder().decode(content);
            writeSize = bytes.length;
            ensureWriteSize(path, writeSize, append);
            if (createDirs && path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            if (append) {
                Files.write(path, bytes, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } else {
                Files.write(path, bytes);
            }
        } else {
            writeSize = content.getBytes(charset).length;
            ensureWriteSize(path, writeSize, append);
            if (createDirs && path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            if (append) {
                Files.writeString(path, content, charset, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } else {
                Files.writeString(path, content, charset);
            }
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", path.toString());
        result.put("written", true);
        result.put("size", Files.size(path));
        return result;
    }

    private JsonNode executeListDir(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        boolean recursive = getBoolean(args, "recursive", false);
        boolean includeHidden = getBoolean(args, "includeHidden", false);

        Path path = resolveExistingAllowedPath(pathStr);
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
        result.put("path", path.toString());
        result.set("entries", entries);
        result.put("count", entries.size());
        return result;
    }

    private JsonNode executeExists(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        Path path = resolveAllowedPathForWrite(pathStr);
        boolean exists = Files.exists(path);
        Path inspected = exists ? resolveExistingAllowedPath(pathStr) : path;

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", inspected.toString());
        result.put("exists", exists);
        result.put("isDirectory", Files.isDirectory(inspected));
        result.put("isFile", Files.isRegularFile(inspected));
        result.put("isReadable", Files.isReadable(inspected));
        result.put("isWritable", Files.isWritable(inspected));
        return result;
    }

    private JsonNode executeMkdir(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        boolean parents = getBoolean(args, "parents", true);

        Path path = resolveAllowedPathForWrite(pathStr);

        if (parents) {
            Files.createDirectories(path);
        } else {
            Files.createDirectory(path);
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", path.toString());
        result.put("created", true);
        return result;
    }

    private JsonNode executeDelete(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        boolean recursive = getBoolean(args, "recursive", false);

        Path path = resolveAllowedPathForWrite(pathStr);
        boolean existed = Files.exists(path);

        if (existed) {
            path = resolveExistingAllowedPath(pathStr);
            ensureNotAllowedRoot(path);
            if (recursive && Files.isDirectory(path)) {
                // Delete directory recursively
                try (Stream<Path> walk = Files.walk(path)) {
                    walk.sorted(Comparator.reverseOrder()) // Reverse order (children first)
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
        result.put("path", path.toString());
        result.put("deleted", existed);
        result.put("existed", existed);
        return result;
    }

    private JsonNode executeStat(JsonNode args) throws IOException {
        String pathStr = getRequiredString(args, "path");
        Path path = resolveAllowedPathForWrite(pathStr);
        boolean exists = Files.exists(path);
        if (exists) {
            path = resolveExistingAllowedPath(pathStr);
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("path", path.toString());
        result.put("exists", exists);

        if (exists) {
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

    private List<Path> parseAllowedRoots(String allowedDirs) {
        if (allowedDirs == null || allowedDirs.isBlank()) {
            return List.of();
        }
        return Stream.of(allowedDirs.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(s -> Path.of(s).toAbsolutePath().normalize())
                .distinct()
                .toList();
    }

    private Path resolveExistingAllowedPath(String pathStr) throws IOException {
        Path raw = normalizeAbsolute(pathStr);
        ensureLexicallyAllowed(raw);
        Path real = raw.toRealPath();
        ensureRealAllowed(real);
        return real;
    }

    private Path resolveAllowedPathForWrite(String pathStr) throws IOException {
        Path raw = normalizeAbsolute(pathStr);
        Path allowedRoot = ensureLexicallyAllowed(raw);
        ensureNoSymlinkEscape(raw, allowedRoot);
        return raw;
    }

    private Path normalizeAbsolute(String pathStr) {
        return Path.of(pathStr).toAbsolutePath().normalize();
    }

    private Path ensureLexicallyAllowed(Path path) {
        Optional<Path> root = allowedRoots.stream()
                .filter(path::startsWith)
                .findFirst();
        if (root.isEmpty()) {
            throw new SecurityException("Path is outside allowed directories: " + path);
        }
        return root.get();
    }

    private void ensureRealAllowed(Path realPath) throws IOException {
        for (Path root : allowedRoots) {
            Path comparableRoot = Files.exists(root) ? root.toRealPath() : root;
            if (realPath.startsWith(comparableRoot)) {
                return;
            }
        }
        throw new SecurityException("Path resolves outside allowed directories: " + realPath);
    }

    private void ensureNoSymlinkEscape(Path rawPath, Path allowedRoot) throws IOException {
        Path cursor = rawPath;
        while (cursor != null && cursor.startsWith(allowedRoot) && !Files.exists(cursor)) {
            cursor = cursor.getParent();
        }
        if (cursor != null && cursor.startsWith(allowedRoot)) {
            ensureRealAllowed(cursor.toRealPath());
        }
    }

    private void ensureFileSize(long size) {
        if (size > maxFileSize) {
            throw new IllegalArgumentException("File exceeds max allowed size of " + maxFileSize + " bytes");
        }
    }

    private void ensureWriteSize(Path path, long incomingBytes, boolean append) throws IOException {
        long existingBytes = append && Files.exists(path) ? Files.size(path) : 0;
        ensureFileSize(existingBytes + incomingBytes);
    }

    private void ensureNotAllowedRoot(Path path) throws IOException {
        Path realPath = path.toRealPath();
        for (Path root : allowedRoots) {
            Path comparableRoot = Files.exists(root) ? root.toRealPath() : root;
            if (realPath.equals(comparableRoot)) {
                throw new SecurityException("Deleting an allowed filesystem root is not permitted: " + root);
            }
        }
    }

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
