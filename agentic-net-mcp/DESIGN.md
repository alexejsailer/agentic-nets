# Agentic-Nets MCP Server (`@agenticnets/mcp`) — Product & Implementation Plan

## Context

AgenticNetOS can be driven from Claude Code today only via the agenticos-control plugin (bash/curl, Claude-Code-only). This plan creates the deferred "Phase 2": an **MCP server** in the public `agentic-nets` repo so *any* MCP client (Claude Code, Claude Desktop, Cursor, agent frameworks) can create personas, nets, tool-nets and brain-nets, and use Agentic-Nets as **working memory**. Grounded by codebase exploration (CLI reuse surface, gateway/master/node auth reality) and a detailed design pass.

## The USP — why a user runs this

**"Working memory that runs."** Against passive memory servers (mem0, KG stores, vector DBs), Agentic-Nets memory is:
1. **Structured & navigable** — tokens in event-sourced places, ArcQL-queryable, connected by link transitions into a traversable graph. (Honest positioning: *structured* working memory; no vector search in v0.1 — `memory_recall` does ArcQL + in-process matching.)
2. **Alive between sessions** — scheduled/continuous transitions distill/consolidate/act on what the client wrote (always-on distiller, digests). No other memory server *thinks while you're gone*.
3. **Crystallizing** — exploration hardens into capability: scaffold a tool-net once, `invoke_tool_net` deterministically forever at zero LLM cost. "Chat agents explore; Agentic-Nets operate."

Secondary: full observability (`event_trail` — auditably answer "why does my memory say X"), formal Petri-net semantics (capacity/consumption/reservations), multi-agent sharing (Claude Code + Telegram bot + GUI on one substrate).

## Product decisions (made by user)

1. Package name **`@agenticnets/mcp`** (dir `agentic-nets/agentic-net-mcp/`, bin `agenticnets-mcp`).
2. Templates v0.1: **working-memory, dev-team, brain, blank**.
3. Default mode **rw** (executor-command reach excluded from curated tools); gateway-enforced readonly opt-in.
4. Distribution **npx + compose image** ⇒ **both transports in v0.1**: stdio (npx / `claude mcp add`) + streamable HTTP (container `alexejsailer/agenticnetos-mcp`, bind 127.0.0.1, bearer-token protected).
5. **The server must teach the client** what Agentic-Nets is and how to use it well.

## Starter templates (solve "empty stack on day one")

| Template | What the user gets |
|---|---|
| `working-memory` (default demo) | `p-mem-inbox/notes/decisions/knowledge/archive` + link graph; `t-mem-distill` (llm kind, always-on: summarizes each inbox capture → notes) + link graph incl. an archive place for future bounding. Note-taking / second-brain case. (An automatic keep-newest-N reaper needs count-aware script logic — a v0.2 template enhancement; recall already caps result size so growth never breaks recall.) |
| `dev-team` | **The safe-team pattern, token-free**: pipeline structure (backlog → task-ready → in-progress → review → done places, deterministic routing maps, scheduled digest/status net, persona charter places) with **the connected coding agent as the worker** — Claude Code pulls tasks via MCP, does the work with its own reasoning, writes results back. Zero server-side LLM tokens; the net provides persistence, state, audit trail, scheduling. |
| `brain` | The staging-proven divergent-ideation pattern: vision/context places, persona charters, scheduled llm consolidation (port of `consolidate_context_inscription()` from `core/scripts/deploy-shared-cognition.py`). Burns server-side LLM by design. |
| `blank` | Net + `p-in`/`p-out` — a canvas for the net-building tools. |

Blueprints are host/model-agnostic JSON in the package, executed by a TS port of the proven python builder flow (`core/scripts/deploy-tool-nets.py` pattern: ensure session tree → designtime → runtime places → assign+inscription leaf → seed-if-empty → start; idempotent on 409/422).

## Teaching the client (first-class v0.1 feature)

- **Server `instructions`** (MCP initialize): compact primer — places/tokens/transitions, memory conventions, when to use which tool, top gotchas (ArcQL `==` + double quotes; capacity-1 semantics; link transitions never fire).
- **Knowledge resources** `agenticnets://docs/{concepts|arcql|transitions|recipes}` — ported from the plugin skill references (`claude-plugin/agenticos-control/skills/*/references/`).
- **Prompts as recipes**: `setup-working-memory`, `work-dev-team-backlog` (pull task → do → report back), `capture-session` (distill conversation into memory), `debug-net` (overview → tokens → event_trail → fire_once).

## Tool surface — 18 curated tools, 3 layers (NOT the raw 85-tool catalog)

**Memory**: `memory_write(text|data, place?, links?)` · `memory_recall(query)` · `memory_link(from, to, label)` · `memory_graph(start?, depth?)`
**Net-building**: `deploy_template` · `create_net` · `add_place` (designtime + runtime both — required for presets to resolve) · `add_transition` (kind-aware, pre-wired command/http/llm inscriptions) · `set_schedule` · `fire_once` · `start_transition` · `stop_transition` · `create_persona` · `scaffold_tool_net` · `invoke_tool_net`
**Observability**: `net_overview` · `query_tokens` · `event_trail` / `events_wait` / `console_tail`
(Master's bounded operational event line) · `model_history` / `event_block_get` (the Node's durable
model EventBlocks through Master/Gateway) · `transition_history` / `token_lineage` /
`failure_context` (causal joins via correlationId, transitionId and fireId) · `service_logs_tail`
(redacted infrastructure fallback).

Read catalogs (`tool-nets`, templates, models) ship as MCP **resources**, not extra tools.

## Model scoping — grounded reality

**No per-model enforcement exists anywhere in the stack** (verified): gateway mints exactly two identities (`agenticos-admin`/`agenticos-readonly`, `GatewayProperties.java`) with a binary `scope` claim (`TokenController.resolveScope()`); `ReadonlyEnforcementFilter` blocks by HTTP method only; master's `user-{userId}` isolation rides an unauthenticated param; node has no security layer. Therefore:
1. **v0.1: server-side allowlist** — `AGENTICOS_MODELS=m1,m2` (first = default). `src/scope.ts` is the single chokepoint: `wrapTool()` resolves/validates `model` on EVERY call (even smuggled args); single-model config ⇒ no `model` param in any advertised schema; violations return tool-level `{code:'MODEL_NOT_ALLOWED', allowedModels}` (never protocol errors — keeps the client LLM in the loop). Docs honest: protects against LLM mistakes/prompt-injection through the client, not a malicious co-tenant.
2. **Readonly IS gateway-enforced**: `AGENTICOS_MODE=readonly` authenticates as `agenticos-readonly` (mutations 403'd by the gateway); additionally, mutating tools are *not registered at all* in readonly mode.
3. **v0.3 platform item**: model-scoped JWTs (a `models` claim in `TokenController` + a modelId-matching filter beside `ReadonlyEnforcementFilter`) → tamper-resistant scoping; independently valuable for multi-tenant stacks.

## Architecture

- **Reuse from `@agenticos/cli` via `file:../agentic-net-cli`** (the `agentic-net-chat` pattern; same tsup/esm/node≥22 toolchain since CLI `exports` point at raw `src/*.ts`): `GatewayClient` (transport + OAuth2 auto-auth, `TokenStore` profiles `mcp`/`mcp-readonly`), `MasterApi`/`NodeApi` (typed wrappers), `ToolExecutor` (execution switch; lazy per-model instance map since it pins modelId per instance), `tools.ts` (`ToolSchema` ≈ MCP inputSchema shape), `roles.ts`. Verified: none of these write to stdout (stdio-safe).
- Gateway-mode only in v0.1 (the CLI has no direct mode) — documented requirement.
- SDK `@modelcontextprotocol/sdk` + zod. Config env-first: `AGENTICOS_GATEWAY_URL`, `AGENTICOS_ADMIN_SECRET(_FILE)` (= secret for whichever clientId the mode selects), `AGENTICOS_MODELS` (required, fail-fast), `AGENTICOS_MODE=rw|readonly`, `AGENTICOS_SESSION=mcp`, `AGENTICOS_NODE_HOST=localhost:8080` (for inscription host injection); HTTP transport adds `AGENTICOS_MCP_HTTP_PORT` + `AGENTICOS_MCP_HTTP_TOKEN`. Secrets never in tool output.

## Package layout

```
agentic-net-mcp/
├── package.json            # @agenticnets/mcp, type:module, file: dep on @agenticos/cli, bin agenticnets-mcp
├── tsup.config.ts          # clone agentic-net-chat's (esm, node22, external bare imports, shebang)
├── Dockerfile              # repo root build context (chat precedent) — HTTP transport entry
├── bin/agenticnets-mcp.ts  # loadConfig → createContext → createServer → stdio | streamable-HTTP
├── src/
│   ├── config.ts  ├── scope.ts  ├── context.ts  ├── server.ts
│   ├── inscriptions.ts     # buildLink/Command/Http/LlmInscription + persistInscriptionLeaf()
│   ├── tools/{memory,nets,observe}.ts
│   ├── resources.ts  ├── prompts.ts  ├── instructions.ts
│   └── templates/{types,executor,index}.ts + {working-memory,dev-team,brain,blank}.json  # statically imported (bundled)
└── test/{scope,templates,schemas,template-executor,integration}.test.ts   # vitest
```

## Key design points (from the design pass — implementation-ready)

- **Memory conventions**: session `mcp`, net `memory`, places `p-mem-*`; short names accepted (`notes` → `p-mem-notes`); token shape `{kind:'memory', text?, ...data, tags?, createdAt, source:'mcp'}`. `memory_write` works *without* the template (auto-creates runtime place); `deploy_template('working-memory')` later upgrades the same places with the distiller (ids match by design).
- **`memory_link`** = kind:link transition assign (NEVER started) with mandatory `presets.from.arcql: "FROM $ LIMIT 1"` (the empty-arcql 400-spam engine gotcha — also enforced by `validateBlueprint()`); designtime mirror + inscription leaf (delete-then-createLeaf; updateProperty 400s) when places are in the net's PNML.
- **`memory_recall`**: `FROM `-prefixed → ArcQL passthrough; otherwise bounded fetch + in-process field/substring match (ArcQL operator surface deliberately not over-trusted in v0.1).
- **`memory_graph`**: `GET_LINKED_PLACES` (supports depth) normalized to `{nodes:[{placeId,label,tokenCount}], edges:[{from,to,label}]}`.
- **Blueprint validation**: unique ids; arcs reference declared ids; presets have non-empty arcql; kind:link ⇒ `start:false`, no action; scheduled transitions ⇒ `start:true`; 6-field cron.
- **Scope guard error shape**: `{isError:true, content:[text: {"code","error","allowedModels"}]}`; `GatewayError` → `{code:'GATEWAY_ERROR', status}`.
- **dev-team blueprint specifics**: routing via deterministic map transitions (template-interpolation root = preset KEY — the known triage lesson); digest net is map-kind (zero LLM); charter places seeded with persona/role tokens; the client works the backlog through `query_tokens(p-task-ready)` + `memory_write`-style result tokens + `fire_once` on the advance transitions — codified in the `work-dev-team-backlog` prompt.

## Files to create/modify

- **New**: everything under `agentic-nets/agentic-net-mcp/` (above), plus a compose service entry for `agenticnetos-mcp` in `deployment/docker-compose*.yml` + `.env.template` keys + `deployment/dockerfiles/Dockerfile.agentic-net-mcp` (follow chat's build-context precedent) + `deployment/scripts/build-and-push.sh` service list addition.
- **Modified (2 lines)**: `agentic-nets/agentic-net-cli/package.json` — add `"./gateway/master-api"` and `"./gateway/node-api"` to `exports`. No CLI source changes.
- Reference sources to port from: `core/scripts/deploy-tool-nets.py` (builder flow + correlation inscriptions), `core/scripts/deploy-shared-cognition.py` (cron schedule format, consolidation inscription), `claude-plugin/agenticos-control/skills/*/references/*` (knowledge resources).

## Implementation order

1. CLI exports 2-liner → 2. scaffold + config + context → 3. `scope.ts` + hermetic tests → 4. observe + memory tools (fastest end-to-end win) → 5. template types/executor + 4 blueprints + `deploy_template` → 6. remaining net tools + `create_persona` → 7. instructions/resources/prompts → 8. HTTP transport + Dockerfile + compose wiring → 9. README + integration tests.

## Verification

- **Hermetic (vitest)**: scope guard truth table (default/passthrough/reject; readonly rejects mutators before any network call); blueprint validation regressions (arcql-on-links, start flags, arc references); schema shaping (single-model ⇒ no `model` param anywhere; readonly ⇒ only read tools registered); template executor ordering + 422-tolerance against an in-memory GatewayClient fake.
- **Integration (local dev stack, `AGENTICOS_IT=1`)**: deploy `blank`; `memory_write` → `memory_recall` roundtrip; `memory_link` → `memory_graph` shows the edge; `event_trail` non-empty; readonly client 403s on write.
- **Live demo path**: `claude mcp add agenticnets -e AGENTICOS_GATEWAY_URL=... -e AGENTICOS_ADMIN_SECRET=... -e AGENTICOS_MODELS=my-notes -- npx @agenticnets/mcp`; then in Claude Code: remember something → recall it → `deploy_template working-memory` → confirm the distill transition ticks on schedule (master log / event trail).
- **Compose**: `docker compose up agenticnetos-mcp` → HTTP transport reachable on 127.0.0.1 with token; bind from Claude Code via URL config.

---

# Phase 2 additions (2026-07-04)

## Client-hosted transitions (IMPLEMENTED: host_transition / unhost_transition)

The inversion that makes llm/agent transitions free to run: the transition is deliberately NOT
started on master; this MCP process is its executor, via the CLI's `executeTransitionLocally`
(preset binding → sub-agent loop → postset emission) on the provider configured by
`AGENTICOS_LLM_PROVIDER` (default **claude-code** — the user's own `claude` binary and
subscription; also ollama / anthropic / openai). `mode:"watch"` polls the input place on an
interval; `mode:"once"` executes a single waiting token. Honest semantics: hosted lanes run only
while the session is connected — tokens wait safely in the input place otherwise; keep 24/7 lanes
on master. Observability: `net_stats.hosted` (ticks/executions/successes/failures/lastError).

## Net Hub — a package manager for AgenticOS (DESIGN)

**Goal.** A hub server ("NetHub") where people publish, search, and install Agentic-Nets artifacts —
templates, tool-nets, persona nets, whole models — so any local AgenticOS (and any MCP client bound
to one) can `hub_search` → `hub_install` a running system in one call. npm for nets.

**What already exists (the hub is mostly assembly, not invention):**
- Package registry inside master: `PACKAGE_SEARCH / PACKAGE_PUBLISH / PACKAGE_INSTALL` (+ REST:
  create/publish/search/info/versions/upload/import) with scopes designtime|runtime|complete and
  **CredentialScrubber on every scope** (secrets stripped at export; `${...}` refs kept).
- `EXPORT_PNML` / net export for single-net artifacts; templates as validated JSON blueprints.
- Gateway with admin/readonly OAuth2 clients — a hub is a stack whose readonly client is public.

**MVP (no new server software):** the hub IS a hosted AgenticOS instance.
1. Operate a public stack (e.g. hub.agentic-nets.com) with a dedicated `hub` model; its package
   registry is the catalog. Anonymous read via the readonly client; publish via issued tokens.
2. MCP tools (small additions): `hub_search {query, tags}` → gateway readonly search on the hub;
   `hub_install {name, version}` → download package from hub → `PACKAGE_INSTALL` into the LOCAL
   model (scrubbed, schema-checked); `hub_publish {netId|template, name, version, tags}` →
   package locally (scrubber runs) → upload to hub with a publish token.
3. Seed catalog: working-memory, dev-team, brain, watcher, research pipeline, ops-sentinel,
   notify tool-nets.

**V2 hardening:** static GitHub-backed index as a zero-infra mirror (packages.json + tarballs);
signatures/checksums on artifacts; license + provenance fields in the manifest; install-time
static verification (verify_inscription across all transitions, no command-kind without explicit
consent flag); download counts/ratings back onto the hub model as tokens — the hub dogfoods nets.

**Trust model:** installs are data + inscriptions, never executed at install time; command-kind
content requires an explicit `--allow-commands` acknowledgement at install; scrubber guarantees
no credentials leave a publisher's stack; readonly hub client means the catalog itself cannot be
mutated by consumers.
