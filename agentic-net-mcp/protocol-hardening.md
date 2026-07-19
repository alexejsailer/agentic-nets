# Protocol hardening — how to make an MCP that agents can't misread

> ## Status — implemented 2026-07-19 (unreleased, post-2.32.0)
>
> | # | Trap class | State |
> |---|---|---|
> | 1 | Scope echo | **DONE** — `net_overview` was already renamed (`sessionNetCount`/`sessionNets` + `modelSessionCount`); now additionally EVERY tool response that doesn't state its model context gets `scope: {model, session}` stamped in-band (`scope.ts` wrapTool). |
> | 2 | Success = effect | **DONE** — `DEPLOY_TRANSITION` no longer no-ops without `inscription` (CLI, was already fixed); `add_place` returns `{designtime, runtime}` on partial failure (already); `create_net` verifies on a 5xx and reports `created`+do-not-retry instead of error-after-success; `readOnlyHint`/`destructiveHint` annotations now derived from `mutates` for ALL tools incl. a truthful native-layer classification. |
> | 3 | Truncate loudly / cursors | **DONE where it lives** — `event_trail` already caps at 200 + accepts `before`; `query_tokens` GET path now applies the documented per-value cap with inline markers + `truncated:true` and honors `fields`. The exact-65536 mid-JSON cap was audited and does NOT exist in CLI/master/node code (the only 65536 is an unwired WebSocket config field) — treat as client-side response truncation; server responses stay valid JSON. |
> | 4 | Validate the whole payload | **DONE at the MCP boundary** — `add_transition` bounces kind-inapplicable params BEFORE any write, naming where each belongs; `tier` on `kind:llm` is now forwarded (master ≥ 2.28 resolves it). Master-side: llm `tier` + error-emit + `@response.json` parse-failure routing were already fixed in 2.28.0. OPEN (deliberate): master's SET_INSCRIPTION path still accepts unknown inscription fields silently (advisory InscriptionValidator has no unknown-key check). |
> | 5 | Names are contracts | **DONE** — `LIST_ALL_INSCRIPTIONS` ↔ `list_transitions` cross-reference both ways (CLI + MCP, was already in); scope/output warnings appended to `GET_SESSION_OVERVIEW`, `EXPORT_PNML`, `DEPLOY_TRANSITION`. OPEN (deliberate): per-tool `outputSchema`/`structuredContent` deferred — SDK validation strips/rejects unknown keys, so declaring schemas on passthrough-shaped tools risks breaking live responses; revisit with fixed response models. |
> | 6 | Chain readiness | **DONE** — new read-only `readiness` tool: gateway auth → node → model (exists/state/workspace) → llm health → executor coverage, per-layer verdicts + `capabilities` + `problems` with a fix each. |
> | 7 | Errors name layer/state/next step | **DONE** — `GATEWAY_ERROR` now carries `layer` (gateway/master/node/vault from the attempted route), `attempted` (METHOD /path — the CLI's GatewayError already records it), and a per-shape `suggestion`; `create_model` checks the NODE, not the client allowlist (was already fixed). |
> | 8 | Scheduler "why not" | **Was already DONE server-side** — master exposes `eligibility` (NOT_RUNNING / WAITING_FOR_SCHEDULE[_AND_TOKENS] / NO_TOKENS / READY / FIRING / ERROR) + lastFiredAt/nextFireAt via `/models/{id}/execution/status`; MCP `scheduler_status` surfaces it (+`overdue`). fireOnce event parity was fixed in 2.28/2.30 (both paths narrate requested/success/error). PNML frozen-tokens now warned on in `EXPORT_PNML`'s description. |

Companion to `improvement-v2.md`. That file lists concrete bugs; this one distills the **trap classes** behind them into design principles for the tool protocol itself. The test for each principle: *would it have prevented an agent from stating something false, or from nearly shipping a wrong side effect?* Every item below traces to a real incident in the sessions of 2026-07-14…19.

The common thread: **every trap was a response that invited misreading while being technically correct.** An agent doesn't fall into traps because data is missing — it falls because the data *looks like* an answer to a different question than the one it actually answers.

---

## 1. Echo the effective scope in every response

**Incident:** `net_overview` returned `netCount: 0` for a model with 16 nets, because the count was silently scoped to the connection's (brand-new) session. The agent reported "this model is empty" to the user.

Any tool whose answer depends on implicit context — session, model, connection env — must state that context *in the shape of the data*, not just adjacently:

```json
{ "scope": { "model": "safe-teams", "session": "mcp-remote", "coverage": "session-only" },
  "sessionNetCount": 0 }
```

Field names carry scope (`sessionNetCount`, not `netCount`). A reader who skims still cannot misread it. Connection-level env (AGENTICOS_MODELS / AGENTICOS_SESSION) is invisible hidden state from the agent's side — every answer that depends on it should surface it.

## 2. Success must equal effect — never succeed silently, never fail successfully

**Incidents:** `DEPLOY_TRANSITION` without `inscription` → `success: true`, nothing assigned. `create_net` → HTTP 500, net actually created. `DELETE_TOKEN` → all-null body, effect unknowable without re-query. `add_place` → design-time half succeeded, runtime half 404'd, error names neither half.

Rules:
- A mutating tool returns an **effect list**: what changed, what didn't (`{performed: false, reason: "..."}` for no-ops). "I did nothing" must be structurally distinguishable from "done".
- A tool that performs N steps reports per-step outcome on partial failure (`{designtime: true, runtime: false}`), or is transactional.
- An error response after a successful mutation is the worst possible output: a careless agent retries and double-creates; a careful one halts to debug a non-problem.
- Free win: `wrapTool` already knows `mutates: true/false` — surface it as the MCP-standard `readOnlyHint`/`destructiveHint` annotations so clients and agents can reason about risk before calling.

## 3. Truncate loudly; if you return a cursor, accept it

**Incidents:** token payload capped at exactly 64 KiB **mid-JSON string** with no flag — nearly fed to an LLM as analysis input. `event_trail {limit: 300}` returned syntactically invalid JSON. `event_trail` returns `nextBeforeSeq` but accepts no `before` parameter, so history beyond the window is unreachable — the `safe-teams` breakage predated the visible trail.

Rules:
- Any size cap sets `truncated: true` and cuts at a structural boundary (whole tokens, whole events) — never mid-value. Invalid JSON out of a tool is always a bug.
- A cursor in the response implies the parameter in the request. Pagination is not optional once data outgrows one response.
- Silent truncation is the worst variant of trap #2: it *is* a partial failure dressed as success, and it composes catastrophically (truncated JSON → LLM → plausible garbage → external delivery).

## 4. Validate the whole payload; unknown fields bounce, unresolved paths fail

**Incidents:** `"tier": "low"` on a `kind: llm` action — silently ignored, agent gets the *expensive* model while believing it chose the cheap one. Template path `${input.data.value.provider}` on a double-encoded string — silently resolved to the parent blob and dumped ~1 KB of escaped JSON into a memo that was minutes from being posted externally.

Rules:
- Schema-validate nested payloads (inscriptions), not just the tool envelope: `additionalProperties: false`, or at minimum a warning channel for ignored fields. An agent's misconception must bounce at the boundary, not vanish into a default.
- Template resolution that fails should **fail the fire** (or route to an error emit), never best-effort fall back to a parent value. A loud error costs one retry; a silent wrong value can cost an external side effect.

## 5. Names are contracts — publish output schemas

**Incident:** `LIST_ALL_INSCRIPTIONS` returns only `{transitionId, id}` — no inscriptions. The agent concluded the capability didn't exist, hand-sampled 16 of 136 transitions, and published a false "missing tool" finding — while `list_transitions` (the actual answer) sat unnoticed.

Rules:
- MCP already supports `outputSchema` and `structuredContent` — use them. An agent that can see the return shape *before calling* cannot be fooled by a name.
- Overlapping tools must cross-reference each other in their descriptions ("returns IDs only; for kind/schedule/status use `list_transitions`"). Agents pick tools by name and description match; a misleading name doesn't just waste a call, it *forecloses the search*.

## 6. Expose readiness of the whole dependency chain, read-only

**Incidents:** MCP handshake "✔ Connected" says nothing about gateway auth. Executor `status: ONLINE` with `connected: false`, serving models list vs `allowedModels: ["*"]` with no stated precedence — undiagnosable during the `safe-teams` post-mortem. Staging LLM depends on a manual `ollama login`; the only check (`GET /api/llm/health`) has no MCP tool. A fresh model's missing `places` container surfaced as bare 404s four tools deep.

Rule: one read-only `health`/`readiness` tool that walks the chain and reports per-layer:

```json
{ "gateway": "authenticated", "node": "reachable",
  "model": { "id": "social-intel", "state": "ACTIVE", "workspaceProvisioned": true },
  "llm": { "provider": "ollama", "status": "READY", "modelPresent": true },
  "executors": [ { "id": "…", "servesThisModel": true, "lastSeen": "…" } ] }
```

Transport-connected ≠ authenticated ≠ backend-ready ≠ capability-ready. An agent should establish all four in one call before building anything — today it takes stdio probes, source reading, and REST calls to internal ports.

## 7. Errors name the failing layer, the state that was checked, and an executable next step

**Incidents:** `create_model` → "already in the allowlist — target it directly" — a **client**-state message for a **server**-state problem (the model didn't exist), with advice that was impossible to follow. `GATEWAY_ERROR 404 "resource not found — check the id/path"` covering four different missing-parent problems without naming the path.

Rule — structured errors:

```json
{ "code": "MODEL_NOT_ON_NODE",
  "layer": "node",
  "checked": { "clientAllowlist": true, "nodeRegistry": false },
  "attemptedPath": "root/workspace/places/p-foo",
  "suggestion": "create_model social-intel (model is allowlisted but does not exist server-side)" }
```

An agent recovers from an error exactly as well as the error describes reality. A wrong `suggestion` is worse than none — it gets *followed*.

## 8. Every scheduler needs a "why not" API — negatives must be observable

**Incidents:** 29 scheduled transitions `RUNNING`, valid schedules, one firing — cause still unknown; the tooling cannot answer "why didn't X fire?". `fireOnce` on a stopped transition emits **no event at all**, making half a pipeline invisible while the user was watching for it. PNML `tokens: 0` is design-time-frozen and reads as live state.

Rules:
- Any polling/scheduling loop exposes per-item `lastEvaluatedAt`, `lastFiredAt`, `nextFireAt`, and `skipReason` (`not-running`, `gate-not-eligible`, `no-binding`, `model-inactive`). The master already tracks most of this (`ScheduleGate`, `ModelExecutionStatusController`) — no MCP tool surfaces it.
- Every execution path (started poll, `fireOnce`, INVOKE) emits the same fire events. Observability that depends on *how* a thing ran will hide exactly the runs you're debugging.
- Never present frozen design-time values in the same field vocabulary as live runtime values.

---

## The meta-rule

Seven of the eight classes reduce to one sentence: **a tool response must be self-describing enough that a correct reading is the only available reading.** Agents operate at speed on pattern recognition; any field that *resembles* a global count, a success, a complete list, or a live status will be read as one. The protocol can't make agents skeptical — but it can make every response answer the three questions an agent won't reliably ask: *scoped to what? did it actually happen? is this everything?*

What the protocol cannot fix (and agent-side discipline must): trusting status fields over observed behavior, skipping ground-truth cross-checks, and treating one lucky observation (a suspiciously round 65536) as a substitute for systematic size limits. Those defenses stay on the agent. But today the server actively *punishes* verification by making it expensive — effect lists, scope echoes, and a chain-health tool would make the cheap path and the safe path the same path.
