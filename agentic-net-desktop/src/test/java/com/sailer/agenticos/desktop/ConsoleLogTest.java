package com.sailer.agenticos.desktop;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The console log must stay bounded — a 452 MB master console log is what prompted this. */
class ConsoleLogTest {

    private static byte[] line(char c, int length) {
        byte[] bytes = new byte[length];
        java.util.Arrays.fill(bytes, (byte) c);
        return bytes;
    }

    @Test
    void staysWithinTwoGenerationsNoMatterHowMuchIsWritten(@TempDir Path logs) throws Exception {
        long cap = 4096;
        try (ConsoleLog log = new ConsoleLog(logs, "master", cap)) {
            byte[] chunk = line('x', 512);
            for (int i = 0; i < 1000; i++) { // 512 KB into a 4 KB cap
                log.write(chunk, chunk.length);
            }
        }

        Path current = logs.resolve("master.console.log");
        Path rolled = logs.resolve("master.console.log.1");
        assertTrue(Files.size(current) <= cap, "current file must respect the cap");
        assertTrue(Files.size(rolled) <= cap, "rolled file must respect the cap");
        // exactly two generations — no unbounded .2/.3 pile-up
        assertEquals(2, Files.list(logs).count());
    }

    @Test
    void keepsTheMostRecentOutput(@TempDir Path logs) throws Exception {
        try (ConsoleLog log = new ConsoleLog(logs, "master", 1024)) {
            log.write(line('o', 900), 900);                              // old
            byte[] newest = "THE-LAST-LINE".getBytes(StandardCharsets.UTF_8);
            log.write(line('n', 900), 900);                              // forces a rotation
            log.write(newest, newest.length);
        }
        String current = Files.readString(logs.resolve("master.console.log"));
        assertTrue(current.contains("THE-LAST-LINE"), "the tail must survive rotation");
    }

    @Test
    void rotatesAnOversizedFileLeftByAnOlderVersionOnOpen(@TempDir Path logs) throws Exception {
        Path current = logs.resolve("master.console.log");
        Files.write(current, line('m', 50_000)); // the pre-rotation 452 MB shape, in miniature

        try (ConsoleLog log = new ConsoleLog(logs, "master", 4096)) {
            log.write("fresh".getBytes(StandardCharsets.UTF_8), 5);
        }

        assertEquals("fresh", Files.readString(current));
        assertEquals(50_000, Files.size(logs.resolve("master.console.log.1")));
    }

    @Test
    void pumpDrainsAProcessStreamAndClosesAtEof(@TempDir Path logs) throws Exception {
        byte[] payload = "hello from the child\n".getBytes(StandardCharsets.UTF_8);
        Thread pump = ConsoleLog.pump(new ByteArrayInputStream(payload),
                new ConsoleLog(logs, "node", 4096), "console-node-test");
        pump.join(5000);

        assertEquals("hello from the child\n", Files.readString(logs.resolve("node.console.log")));
        assertTrue(pump.isDaemon(), "pump must never hold up shutdown");
    }
}
