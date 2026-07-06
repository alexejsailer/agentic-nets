package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The config-driven bash command allow/deny policy (validate()). Default is allow-everything;
 * a denylist regex blocks matching commands; a non-empty allowlist permits only matching ones.
 */
class BashCommandHandlerPolicyTest {

    private final ObjectMapper om = new ObjectMapper();

    private BashCommandHandler handler(String denylist, String allowlist) {
        return new BashCommandHandler(om, null, 600_000L, 131072L, 2000, denylist, allowlist);
    }

    private CommandToken exec(String command) {
        ObjectNode args = om.createObjectNode();
        args.put("command", command);
        return new CommandToken("command", "cmd-1", "bash", "exec", args, "json", null, null, null);
    }

    @Test
    void defaultPolicy_allowsEverything() {
        assertNull(handler("", "").validate(exec("rm -rf /tmp/whatever")));
    }

    @Test
    void denylist_blocksMatchingCommand() {
        BashCommandHandler h = handler("rm\\s+-rf\\s+/", "");
        String err = h.validate(exec("rm -rf /"));
        assertNotNull(err);
        assertTrue(err.contains("denylist"), err);
        // A non-matching command still runs.
        assertNull(h.validate(exec("ls -la")));
    }

    @Test
    void allowlist_permitsOnlyMatching() {
        BashCommandHandler h = handler("", "^git\\s,^ls\\s");
        assertNull(h.validate(exec("git status")));
        String err = h.validate(exec("curl http://evil"));
        assertNotNull(err);
        assertTrue(err.contains("allowlist"), err);
    }

    @Test
    void denylist_isCaseInsensitive() {
        assertNotNull(handler("shutdown", "").validate(exec("SHUTDOWN now")));
    }
}
