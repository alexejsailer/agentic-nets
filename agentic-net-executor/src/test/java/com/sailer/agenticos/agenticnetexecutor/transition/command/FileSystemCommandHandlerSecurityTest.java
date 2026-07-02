package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Security regression tests for {@link FileSystemCommandHandler}: every filesystem command must stay inside
 * the configured allowed roots. A regression here would let the executor read or write arbitrary host paths,
 * so these guard the boundary (in-root access works; outside-root, path-traversal, absolute-system-path, and
 * allowed-root deletion are all rejected as failed results, not exceptions that leak through).
 */
class FileSystemCommandHandlerSecurityTest {

    @TempDir
    Path allowed;                 // the only allowed root for this handler

    private final ObjectMapper om = new ObjectMapper();
    private FileSystemCommandHandler handler;

    @BeforeEach
    void setUp() {
        handler = new FileSystemCommandHandler(om, allowed.toString(), 10_485_760L);
    }

    private CommandResult run(String command, ObjectNode args) {
        CommandToken token = new CommandToken("command", "cmd-1", "fs", command, args, "json", null, null, null);
        return handler.execute(token);
    }

    private ObjectNode args() {
        return om.createObjectNode();
    }

    @Test
    void writeThenReadInsideAllowedRoot_succeeds() {
        ObjectNode w = args();
        w.put("path", allowed.resolve("hello.txt").toString());
        w.put("content", "hi there");
        assertEquals(CommandResult.Status.SUCCESS, run("writeFile", w).status());

        ObjectNode r = args();
        r.put("path", allowed.resolve("hello.txt").toString());
        CommandResult read = run("readFile", r);
        assertEquals(CommandResult.Status.SUCCESS, read.status());
        assertNotNull(read.output());
        assertTrue(read.output().toString().contains("hi there"));
    }

    @Test
    void writeOutsideAllowedRoot_isRejected() {
        Path outside = allowed.getParent().resolve("escape-" + System.nanoTime() + ".txt");
        ObjectNode w = args();
        w.put("path", outside.toString());
        w.put("content", "should not be written");
        CommandResult res = run("writeFile", w);
        assertEquals(CommandResult.Status.FAILED, res.status(), "a write outside the allowed root must fail");
        assertNotNull(res.error());
        assertTrue(res.error().toLowerCase().contains("allowed"), "error should name the allowed-directory rejection");
        assertFalse(Files.exists(outside), "a rejected write must not create the file");
    }

    @Test
    void pathTraversalEscape_isRejected() {
        Path escaped = allowed.getParent().resolve("traversal.txt");
        ObjectNode w = args();
        w.put("path", allowed.resolve("../traversal.txt").toString()); // normalizes outside the root
        w.put("content", "x");
        CommandResult res = run("writeFile", w);
        assertEquals(CommandResult.Status.FAILED, res.status(), "a `..` escape must fail after normalization");
        assertFalse(Files.exists(escaped));
    }

    @Test
    void readAbsoluteSystemPath_isRejected() {
        ObjectNode r = args();
        r.put("path", "/etc/hosts"); // exists on macOS/Linux, but outside the allowed root
        CommandResult res = run("readFile", r);
        assertEquals(CommandResult.Status.FAILED, res.status(), "reading an absolute system path outside the root must fail");
    }

    @Test
    void deletingTheAllowedRootItself_isRejected() {
        ObjectNode d = args();
        d.put("path", allowed.toString());
        CommandResult res = run("delete", d);
        assertEquals(CommandResult.Status.FAILED, res.status(), "deleting an allowed root must be forbidden");
        assertTrue(Files.exists(allowed), "the allowed root must survive a rejected delete");
    }
}
