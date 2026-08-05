# External fires: the host model is the LLM

`external` llm/agent transitions are skipped by master. This MCP session supplies the model;
master still binds tokens, builds prompts, applies emit rules, consumes, and records usage.
Mixed master/external nets are supported. Unlike `host_transition`, this needs no provider config.

## Flow

1. `set_external {transitionId, external:true}`. Bulk scopes: `transitionIds`, `netId`,
   `sessionId`, `all:true`. Model/session/net policies persist and apply to new transitions with
   matching metadata; transition choices override them. `external:false` returns to stopped.
2. `list_external_fires` finds work. `includeStopped:true` adds stopped lanes;
   **`includeAll:true` lists every llm/agent lane whatever its status**. Check
   `executionBackend`, `requiresServerLlmProvider`, and the servable verdict: with no provider,
   API-backed lanes need a client while CLI-backed agents remain master-owned.
3. `prepare_external_fire {transitionId}` returns a 30-minute leased `fireId`, bound tokens,
   and `prompt`/`systemPrompt` (llm) or `nl` plus capability policy (agent).
4. Reason, then call
   `complete_external_fire {transitionId, fireId, response | emissions | summary}`.
   Master emits/consumes and books `provider: external:mcp-<session>`.
5. `{success:false,error}` or `abandon_external_fire` preserves inputs.

## Servable

Rows carry `servable` + `servableReason`. Yes: `MARKED_EXTERNAL`, `MASTER_HAS_NO_PROVIDER`
(stranded), `CLI_BINARY_MISSING` (stranded — a bash-backed lane whose claude/codex master cannot
reach), `LANE_IDLE`. No: `MASTER_OWNS_IT`, `NO_TOKENS_BOUND`, `POSTSET_AT_CAPACITY`,
`FIRE_IN_FLIGHT`, `NOT_DEPLOYED`. Advice, not a gate.

`external` is only ever set by hand. A provider-less master marks nothing — it skips only its
provider-backed AI lanes, which keep a normal status and wait for you. An agent with
`llmMode:"bash"` continues to run through Claude Code/Codex and normally reports
`servableReason:"MASTER_OWNS_IT"`; do not race it from a connected client.

## Guarantees

- Leases prevent two clients preparing the same tokens; owner-CAS release cannot unlock a newer lease.
- Completion validates first and is idempotent: retries never emit twice. A running lane may be
  taken over (master stands down while the fire is in flight); only `starting` is refused.
- Master authorizes every agent tool against returned `allowedTools` and `resourceScopes`.
- Master LLM freeze/breaker accounting excludes external fires.
- Events share one correlation: `external-prepared` → `external-completed`.
