# External fires: the host model is the LLM

**Any llm/agent transition can be fired externally on demand, whatever its status** — external,
stopped, or running (takeover). This MCP session supplies the model; master still binds tokens,
builds prompts, applies emit rules, consumes, and records usage. Marking a lane `external` is a
standing POLICY (master never fires it, ever), not a precondition for a one-off client fire.
Mixed master/external nets are supported. Unlike `host_transition`, this needs no provider
config. Deterministic kinds (pass/map/http/command) are already on-demand via `fire_once` — so
between the two, every transition of a model is client-fireable at any time.

## Flow

1. Optional: `set_external {transitionId, external:true}` when master should PERMANENTLY leave
   the lane to clients. Bulk scopes: `transitionIds`, `netId`, `sessionId`, `all:true`.
   Model/session/net policies persist and apply to new transitions with matching metadata;
   transition choices override them. `external:false` returns to stopped. For a one-off
   on-demand fire, skip this step entirely and go straight to prepare.
2. `list_external_fires` finds work. `includeStopped:true` adds stopped lanes;
   **`includeAll:true` lists every llm/agent lane whatever its status**. Check
   `executionBackend`, `requiresServerLlmProvider`, and the servable verdict: with no provider,
   API-backed lanes need a client while CLI-backed agents remain master-owned.
3. `prepare_external_fire {transitionId}` returns a 30-minute leased `fireId`, bound tokens,
   and `prompt`/`systemPrompt` (llm) or `nl` plus capability policy (agent).
4. Reason, then call
   `complete_external_fire {transitionId, fireId, response | emissions | summary}`.
   Master emits/consumes and books `provider: external:mcp-<session>`.
5. On failure, know the difference (lab-verified):
   - `abandon_external_fire` — guaranteed no-trace release: lease cleared, tokens reusable,
     no fire recorded.
   - `{success:false, error}` on an **agent** fire — inputs always preserved for retry.
   - `{success:false, error}` on an **llm** fire — the error is routed through a matching
     `when:"error"` emit rule: an error token is emitted and the inputs are CONSUMED, exactly
     like a native fire recording its failure. Inputs are preserved only when no emit rule
     matches. If you want a retry, abandon; if you want the net to see the failure, complete
     with success:false.

## Where tokens can go

`complete_external_fire` emissions are **postset-scoped**: `place` must name one of the
transition's postsets (key or place name) — anything else is a 400 listing the valid keys.
"The agent freely creates tokens" is the OTHER channel: DURING the fire, use the granted
tools (`CREATE_TOKEN`, `MEMORY_WRITE`, …) to write any place your capability allows —
including places outside the net. Intermediate findings go through tools mid-fire;
the final result goes through emissions/summary at complete time.

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

- Leases prevent two clients preparing the same tokens; owner-CAS release cannot unlock a newer
  lease. A second prepare while a fire holds the lease gets `ready:false` — the leased token is
  simply invisible to the new binding (see docs/leases). Nuance: a lane whose presets are ALL
  `consume:false` leases nothing, so concurrent prepares both succeed there by design — reads
  need no mutual exclusion. Flip side: if both then COMPLETE, both emissions land — no lease
  arbitrates a read-only race; avoiding duplicates is on the caller.
- Completion validates first and is idempotent: retries never emit twice, a rejected (400) body
  never burns the fireId (the lease survives for a corrected retry), and an unknown/expired
  fireId is a 409. A running lane may be taken over (`takenOverFromMaster:true`; master stands
  down while the fire is in flight); only `starting` is refused.
- The agent tool guard is a whitelist, not a mutation filter: during an active agent fire EVERY
  tool call — read-only ones included — must be in `allowedTools`, and master re-authorizes each
  call. Outside the fire the guard is inert.
- Master authorizes every agent tool against returned `allowedTools` and `resourceScopes`.
- Master LLM freeze/breaker accounting excludes external fires.
- Events share one correlation: `external-prepared` → `external-completed`; usage_report books
  the fire under `provider: external:<worker>` with your reported `llmModel` as resolvedModel.
