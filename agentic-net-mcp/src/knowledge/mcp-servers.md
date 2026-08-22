# Giving an agent transition its own MCP servers

You reach Agentic-Nets over MCP. An **agent transition inside a net can do the same thing**: call
external MCP servers itself, while it fires, unattended. The servers are declared in the
inscription, so the net — not the model — decides what the agent may reach.

MCP answers *what an agent can reach*. The net answers *under what rules*.

## The four gates

An agent's MCP call has to pass all four. Any one missing and nothing happens.

| Gate | Where | If missing |
|---|---|---|
| `m` role flag (11th slot of `rwxhludctsm`) | `action.role` | MCP_CALL is never in the agent's tool list |
| Server declaration | `action.mcp[]` | "Unknown MCP server 'x'. Declared servers: [...]" |
| `allowTools` (optional) | per server | "BLOCKED: Tool 'y' is not in server 'x' allowTools" |
| Credential | vault, by `credentialKey` | Server is UNAVAILABLE, zero outbound calls made |

The declaration IS the allowlist. The flag alone reaches nothing; a declaration without the flag
reaches nothing either — and that second shape is the dangerous one, because discovery still runs
and the prompt still lists the servers, so the lane looks healthy while the agent has no way to
call anything. `mcp_servers` reports `mcpFlag:false` on exactly that.

## Wiring one

```
add_transition {netId, transitionId:"t-analyst", kind:"agent", inputPlace, outputPlace,
                prompt:"...", role:"rwxh------m",
                mcp:[{name:"tools", url:"https://tools.example.com/mcp",
                      auth:{type:"bearer", credentialKey:"TOOLS_TOKEN"},
                      allowTools:["search","fetch"]}]}
set_transition_credentials {transitionId:"t-analyst", credentials:{TOOLS_TOKEN:"..."}}
mcp_servers {transitionId:"t-analyst"}          # prove master reaches it, before spending a token
```

The `m` flag is added for you when you pass `mcp` — declaring servers is the intent to use them.
An explicit 11-slot role that denies it (`rwxh-------`) alongside a declaration is rejected as a
contradiction rather than silently resolved either way.

`attach_mcp_server` does the same job on a lane that already exists, and stores the credential in
the same call.

## Giving the agent Agentic-Nets itself

An Agentic-Nets MCP server is just another MCP server, so an agent can be given one — including
the one you are talking to. That is how a lane gets working memory, net structure, or the ability
to build nets, without any of it being wired into the inscription by hand.

```
mcp_servers                                       # self.attachable? at which url?
attach_mcp_server {transitionId:"t-analyst", self:true,
                   allowTools:["query_tokens","memory_recall"]}
```

`self:true` writes this server's own bearer token straight into the transition's vault entry. The
secret never passes through your context — which is the whole point of `credentialKey`, and the
reason this is a tool rather than a documented copy-paste.

Three things to know before you do it:

1. **Transport.** Only a server on the HTTP transport can be handed over; a stdio process has no
   endpoint for master to call. `mcp_servers.self.attachable` says which you have.
2. **Scope is the target server's, not the caller's.** An agent calling that endpoint acts with
   the *target* server's `AGENTICOS_SESSION` and model allowlist. A net it creates lands in that
   session, not in the calling net's.
3. **Recursion is real.** An unrestricted Agentic-Nets server lets the agent author nets,
   including agent lanes. Narrow it with `allowTools` unless authoring is the point.

## Verifying without spending tokens

`mcp_servers {transitionId}` asks master to resolve the lane's declarations with the real vault
credentials and run the real handshake, then reports per server: `credentialResolved`, `healthy`,
and the exact tool list the agent will be offered. It never starts an agent session, so it costs
no LLM tokens. Run it after wiring and after any credential change.

## Failure semantics: degrade, never fail

A broken MCP server does not break the fire. Unreachable, unauthenticated, timed out, oversized,
or returning a JSON-RPC error — each becomes a structured tool failure the agent sees and can
reason about, and the transition still completes. That is deliberate: an external dependency
should not be able to wedge a net.

The cost is that a silently misconfigured lane looks successful. Check `mcp_servers`, don't infer
health from `_status: success`.

## Traps

1. A declaration without the `m` flag looks completely healthy. Always check `mcpFlag`.
2. Inline secrets in an `auth` block are ignored at runtime and redacted on publish, so the
   artifact installs and then 401s. The builders reject them at authoring time; hand-written
   inscriptions do not get that protection.
3. Changing an inscription stops the lane. `attach_mcp_server` leaves it stopped on purpose —
   start it once you have verified.
4. Discovery is cached per transition, keyed by the declared servers, so editing the declaration
   busts it but fixing a credential does not need to: a missing credential is never negative-cached.
5. `url` must be `http(s)` and Streamable HTTP. There is no stdio transport for agent-side MCP —
   master would have no process to spawn.
6. Timeout errors surface as the raw reactive message ("Did not observe any item ... within
   3000ms"). Cosmetic, but do not read it as a protocol error.
