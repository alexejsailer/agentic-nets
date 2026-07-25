# External fires: the host model is the LLM

`external` llm/agent transitions are skipped by master. This MCP session supplies the model;
master still binds tokens, builds prompts, applies emit rules, consumes, and records usage.
Mixed master/external nets are supported. Unlike `host_transition`, this needs no provider config.

## Flow

1. `set_external {transitionId, external:true}`. Bulk scopes: `transitionIds`, `netId`,
   `sessionId`, `all:true`. Model/session/net policies persist and apply to new transitions with
   matching metadata; transition choices override them. `external:false` returns to stopped.
2. `list_external_fires` finds work. `includeStopped:true` includes stopped llm/agent lanes.
3. `prepare_external_fire {transitionId}` returns a 30-minute leased `fireId`, bound tokens,
   and `prompt`/`systemPrompt` (llm) or `nl` plus capability policy (agent).
4. Reason, then call
   `complete_external_fire {transitionId, fireId, response | emissions | summary}`.
   Master emits/consumes and books `provider: external:mcp-<session>`.
5. `{success:false,error}` or `abandon_external_fire` preserves inputs.

## Guarantees

- Leases prevent two clients preparing the same tokens; owner-CAS release cannot unlock a newer lease.
- Completion validates first and is idempotent: retries never emit twice. Running lanes are refused.
- Master authorizes every agent tool against returned `allowedTools` and `resourceScopes`.
- Master LLM freeze/breaker accounting excludes external fires.
- Events share one correlation: `external-prepared` → `external-completed`.
