# @agenticnets/mcp — working memory that runs

An [MCP](https://modelcontextprotocol.io) server that connects any MCP client (Claude Code, Claude
Desktop, Cursor, agent frameworks) to an [AgenticNetOS](https://github.com/alexejsailer/agentic-nets)
stack — turning Agentic-Nets into your agent's **persistent, structured working memory** and a
**net-building workbench**.

Why this beats a passive memory store:

1. **Structured & navigable** — memories are tokens in event-sourced places, queryable with ArcQL
   and connected into a traversable knowledge graph (`memory_graph`), with a full provenance trail
   per token (`event_trail`: auditably answer *"why does my memory say X?"*).
2. **Alive between sessions** — scheduled transitions distill, consolidate, and digest what your
   agent wrote, server-side, while you're gone. Deploy `working-memory` and watch a raw capture
   become a clean durable note seconds later — no client involved.
3. **Crystallizing** — patterns your agent figures out once become deterministic tool-nets it can
   invoke forever at zero LLM cost (`scaffold_tool_net` / `invoke_tool_net`).

## 30-second start

You need a running AgenticNetOS stack ([deployment/](../deployment/)) and its gateway admin secret
(auto-generated at `deployment/data/gateway/jwt/admin-secret` on first startup).

```bash
claude mcp add agenticnets \
  -e AGENTICOS_GATEWAY_URL=http://localhost:8083 \
  -e AGENTICOS_ADMIN_SECRET=<your-gateway-admin-secret> \
  -e AGENTICOS_MODELS=my-memory \
  -- npx @agenticnets/mcp
```

Then, in Claude Code:

> *"Set up my working memory"* → deploys the template
> *"Remember: we picked tsup for all TS packages because the CLI exports raw sources"* → `memory_write`
> *"What did we decide about bundling?"* → `memory_recall` returns the **distilled** note — cleaned up
> server-side by the always-on distiller transition while you kept working.

## Tools (103 = 32 curated + 71 native)

Two layers, one server:

- **Curated (lowercase)** — the ergonomic layer: pre-wired inscriptions, session fallbacks, engine
  gotchas absorbed. Prefer these for the flows they cover.
- **Native (UPPERCASE)** — **full platform parity**: every tool the Agentic-Nets ToolExecutor
  implements (the exact catalog agent transitions use in-net), auto-registered with its real
  description and schema. New platform tools appear here automatically on the next catalog sync.
  Browse them via the `agenticnets://tool-catalog` resource.

| Layer | Tools |
|---|---|
| **Memory** | `memory_write` · `memory_recall` · `memory_link` · `memory_graph` |
| **Net building** | `deploy_template` · `create_net` · `add_place` · `add_transition` (kind-aware: map/llm/http/command/**agent**/link, pre-wired inscriptions) · `set_schedule` · `fire_once` · `start_transition` · `stop_transition` · `create_persona` · **`spawn_persona`** · `scaffold_tool_net` · `invoke_tool_net` · **`crystallize_session`** |
| **Model lifecycle** | **`list_models`** (every model + an `allowed` flag) · **`create_model`** (mint a NEW model, optionally deploy a template into it; joins the allowlist for this session — rw, gated by `AGENTICOS_ALLOW_MODEL_CREATE`) |
| **Model control** | **`pause_model`** (kill switch: stop ALL running transitions, audit-recorded) · **`resume_model`** (restore exactly the paused set) · **`DELETE_TRANSITION`** (deregister an orphaned runtime transition) |
| **Client-hosted execution** | **`host_transition`** (run an llm/agent transition IN the MCP process on the client side's own LLM — default the local `claude` binary; `watch` polls its inbox, `once` executes now) · **`unhost_transition`** |
| **NetHub** | **`hub_publish`** (publish a net/session/**whole model** as a versioned artifact; `tokens=none\|config\|all`) · **`hub_search`** (browse local or a peer's catalog) · **`hub_install`** (install; model artifacts create a new model + join the allowlist) · **`hub_add_remote`** (register a peer instance) |
| **Observability & debugging** | `net_overview` · `query_tokens` · `event_trail` · **`net_stats`** · **`verify_inscription`** · **`dry_run_transition`** · **`diagnose_transition`** |
| **Native catalog (61)** | Structure: `CREATE/DELETE_NET·PLACE·TRANSITION·ARC·TOKEN`, `SET_INSCRIPTION`, `ADAPT_INSCRIPTIONS` · Reads: `QUERY_TOKENS`, `GET_NET_STRUCTURE`, `LIST_*`, `FIND_*`, `EXTRACT_*`, `EXPORT_PNML` · Diagnosis: `NET_DOCTOR`, `VERIFY_NET`, `VERIFY_RUNTIME_BINDINGS`, `VERIFY_INSCRIPTION`, `DIAGNOSE/DRY_RUN_TRANSITION` · Lifecycle: `DEPLOY/START/STOP_TRANSITION`, `FIRE_ONCE`, `EXECUTE_TRANSITION(_SMART)` · Tool-nets: `SCAFFOLD/REGISTER/DESCRIBE/INVOKE_TOOL_NET`, `LIST_TOOL_NETS` · Packages: `PACKAGE_SEARCH/PUBLISH/INSTALL` · Infra: `DOCKER_RUN/STOP/LIST/LOGS`, `REGISTRY_*`, `HTTP_CALL` · Sessions: `CREATE_SESSION`, `TAG_SESSION`, `LIST_ALL_SESSIONS`, … (excluded: `THINK`/`DONE`/`FAIL` — agent-loop-only primitives) |

Four capabilities the extra tools unlock:

- **`spawn_persona`** stands up a *complete self-driving worker net* (charter + task inbox + a started
  `agent` transition + output). Feed it `memory_write place:"p-<name>-task"` and it works each task
  autonomously, server-side — spawn several and they run **in parallel** while you keep working.
- **`crystallize_session`** records what a session did (summary + the concrete API-calls/commands) into
  memory *and* bakes the steps into a replayable command tool-net — "capture what we did so next time
  you just run it and ping for the result".
- **`net_stats`** + the diagnostics are a **no-logs cockpit**: what's RUNNING vs erroring, what is
  **scheduled** to fire unattended (cron/interval — your overnight autonomy, visible), LLM consumption
  per transition, recent errors, and per-transition `verify`/`dry-run`/`diagnose` — debug a net purely
  through the API, with no container or source access.
- **`pause_model`** / **`resume_model`** give the user the **off switch**: pause stops every running
  transition (zero fires, zero LLM spend, schedules frozen) and records the set as an audit token in
  `p-mcp-control`; resume restores exactly that set. `net_stats.paused` is the verification.
- **`host_transition`** inverts where AI runs: an llm/agent transition that is *never started on
  master* gets executed **by this MCP process**, on the LLM the client side already has
  (`AGENTICOS_LLM_PROVIDER` — default `claude-code`, i.e. your own `claude` binary and subscription;
  or ollama/anthropic/openai). Zero server-side LLM setup. Hosted lanes run while the session is
  connected; tokens arriving meanwhile wait safely in the input place. Stats: `net_stats.hosted`.

Plus **resources** (`agenticnets://models`, `agenticnets://templates`, `agenticnets://tool-nets`,
`agenticnets://docs/{concepts,arcql,recipes,security}`) and **prompts** (`setup-working-memory`,
`work-dev-team-backlog`, `capture-session`, `debug-net`, `spawn-worker`, `monitor-personas`).
The server also ships rich `instructions` at initialize, so your client knows how to use
Agentic-Nets well without reading any docs.

## Starter templates

| Template | What you get |
|---|---|
| `working-memory` | Memory places + link graph + an **always-on LLM distiller** (raw inbox capture → durable note) — the second-brain setup. |
| `dev-team` | **Token-free development pipeline** (backlog → ready → in-progress → review → done, WIP limits, daily digest) where *your connected agent is the worker* — the net provides persistence, state, and audit; zero server-side LLM cost. |
| `brain` | Divergent ideation: topic inbox → LLM panel → critic pass → vetted shortlist (this one runs server-side LLM calls). |
| `watcher` | **Zero-LLM overnight sentinel**: cron-probes a URL, logs every result, POSTs `{"text": "..."}` to a webhook when the probe is not 200. Params: `url`, `webhook`, `cron`, `label`. "It tells you when it breaks." |
| `blank` | An empty canvas for `add_place` / `add_transition`. |

Deploys are idempotent: re-running skips existing elements and never duplicates seed tokens.

## Configuration

| Env | Meaning | Default |
|---|---|---|
| `AGENTICOS_GATEWAY_URL` | AgenticNetOS gateway | `http://localhost:8083` |
| `AGENTICOS_ADMIN_SECRET` / `AGENTICOS_GATEWAY_SECRET_FILE` | client secret for the selected mode's client | — (required) |
| `AGENTICOS_MODELS` | **model allowlist**, comma-separated; first = default | — (required) |
| `AGENTICOS_MODE` | `rw` \| `readonly` | `rw` |
| `AGENTICOS_SESSION` | session name for MCP-created nets | `mcp` |
| `AGENTICOS_NODE_HOST` | host injected into inscriptions | `localhost:8080` |
| `AGENTICOS_MCP_TRANSPORT` | `stdio` \| `http` | `stdio` |
| `AGENTICOS_MCP_HTTP_PORT` / `AGENTICOS_MCP_HTTP_TOKEN` | HTTP transport port + required bearer token | `8091` / — |
| `AGENTICOS_LLM_PROVIDER` | LLM used when **this process** executes hosted transitions (`host_transition`): `claude-code` (local `claude` binary — your subscription), `ollama`, `claude`/`anthropic`, `openai` | `claude-code` |
| `AGENTICOS_LLM_MODEL` / `AGENTICOS_LLM_TIER` | model + tier for the hosted-execution provider | provider default / `medium` |
| `AGENTICOS_ALLOW_MODEL_CREATE` | register `create_model` and let it mint new models at runtime (rw only). `false` = strictly-frozen allowlist | `true` (rw) |
| `AGENTICOS_DOCKER_TOOLS` | `false` withholds the container/registry tools (`DOCKER_*`, `REGISTRY_*`) from the native catalog — container spawning as a deliberate grant, mirroring the master's D flag | `true` |

## Claude Code hooks: memory with zero discipline

`hooks/` ships two fail-open scripts that make working memory automatic:

- **`agenticnets-recall.sh`** (SessionStart) — injects your newest decisions + notes as session
  context, so every session starts warm.
- **`agenticnets-capture.sh`** (SessionEnd) — writes one capture token (first ask + final outcome +
  cwd/branch) to `p-mem-inbox`; the working-memory distiller turns it into a durable note on its
  next tick. No LLM in the hook itself.

Setup: create `~/.agenticnets/hooks.env` (`AGENTICOS_GATEWAY_URL`, `AGENTICOS_ADMIN_SECRET` or
`AGENTICOS_GATEWAY_SECRET_FILE`, `AGENTICOS_MEMORY_MODEL`) and register both scripts in
`~/.claude/settings.json` under `hooks.SessionStart` / `hooks.SessionEnd` (`type: "command"`).
Both scripts exit 0 on ANY failure with bounded timeouts — a memory hiccup never blocks a session.

### Model scoping

Every tool call is validated against `AGENTICOS_MODELS` **inside this server** — out-of-list models
return `MODEL_NOT_ALLOWED`; with a single configured model, tools don't even expose a `model`
parameter. Honest boundary: the underlying gateway credential is not model-scoped (the platform has
no per-model authorization yet), so this protects against client/LLM mistakes and prompt injection —
not against a malicious operator of this process.

### Readonly mode

`AGENTICOS_MODE=readonly` registers **only** the six GET-safe read tools (`memory_recall`,
`memory_graph`, `net_overview`, `query_tokens`, `event_trail`, `net_stats`) *and* authenticates with
the gateway's `agenticos-readonly` client — mutations are rejected by the gateway itself, not just by
this server. Point `AGENTICOS_ADMIN_SECRET` at the readonly client's secret.

ArcQL under readonly: read-only ArcQL query POSTs (`/arcql/query/*`, `/proxy/arcql/*/query`) ARE
allowed by the gateway's readonly scope — recall and `query_tokens` work with or without an `arcql`
argument. The native UPPERCASE catalog and the POST-based diagnostics remain rw-only (they mutate or
travel as non-whitelisted POSTs, so they are not advertised in readonly).

### Gateway auth — verified live

Every gateway endpoint sits behind OAuth2. Probed against a live stack:

| Caller | Reads | Mutations (write / start-stop / delete / create-model) |
|---|---|---|
| **No token** | **401** | **401** — nothing works unauthenticated (only `/api/health` is public) |
| **Readonly token** (`agenticos-readonly`) | **200** (incl. ArcQL query POSTs) | **403** — rejected by the gateway itself |
| **Admin token** (`agenticos-admin`) | 200 | 200 |

## Security

Verified posture (adversarial probe: 194 KB of server output + stderr audited):

- **Secrets never surface.** The gateway secret is read only from `AGENTICOS_ADMIN_SECRET` /
  `AGENTICOS_GATEWAY_SECRET_FILE`, held in-process, and never appears in any tool output, error, or
  log line — including error paths. The JWT is auto-acquired and cached; it is not returned to the client.
- **Input is stored as data, not evaluated.** Unicode, emoji, quotes, newlines, and `${...}` /
  backtick sequences round-trip intact as literal token content — they are never interpolated or
  executed by the memory tools. Large tokens are accepted; recall previews are bounded (≤300 chars).
- **Model allowlist** is enforced in-process on every call (out-of-list → `MODEL_NOT_ALLOWED`); a
  single-model config exposes no `model` param at all. Honest boundary: the underlying gateway
  credential is not model-scoped (the platform has no per-model authz yet), so this guards against
  client/LLM mistakes and prompt injection — not a malicious operator of this process.
- **Readonly is gateway-enforced** (not just tool-filtered): `AGENTICOS_MODE=readonly` authenticates
  as the `agenticos-readonly` client, so mutations are rejected by the gateway itself.

⚠️ **Command tool-nets run arbitrary shell.** `scaffold_tool_net` with `transitionKind=command` (and
any command-kind transition you build) executes its input on the distributed executor — that is the
feature, but it means an `rw` connection can run shell there — up to and including **spawning full
Claude Code instances** (`claude -p '…' --allowedTools … < /dev/null`) as net workers. Only grant `rw`
to trusted clients; use `readonly` for untrusted or shared bindings, and scope `AGENTICOS_MODELS` to a
dedicated model.

⚠️ **Scheduled transitions act unattended.** Anything armed with `scheduleCron`/`intervalMs` keeps
firing server-side — overnight, with no client connected, possibly spending LLM. `net_stats.scheduled`
lists everything armed; `pause_model` freezes it all instantly.

## Running in the compose stack (HTTP transport)

The deployment stack ships an opt-in `agentic-net-mcp` service:

```bash
cd deployment
echo 'AGENTICOS_MCP_HTTP_TOKEN='$(openssl rand -hex 24) >> .env
COMPOSE_PROFILES=mcp docker compose -f docker-compose.hub-only.yml up -d agentic-net-mcp
# MCP endpoint: http://127.0.0.1:8091/mcp   (Authorization: Bearer <token>)
```

## Development

```bash
npm install       # pulls @agenticos/cli via file:../agentic-net-cli
npm run build     # tsup — bundles the CLI client layer inline
npm test          # vitest: scope guard, blueprint invariants, protocol surface, template executor
npm run typecheck
```

License: BSL 1.1 — see [LICENSE.md](../LICENSE.md).
