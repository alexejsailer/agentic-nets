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

## Tools (18, curated)

| Layer | Tools |
|---|---|
| **Memory** | `memory_write` · `memory_recall` · `memory_link` · `memory_graph` |
| **Net building** | `deploy_template` · `create_net` · `add_place` · `add_transition` (kind-aware, pre-wired inscriptions) · `set_schedule` · `fire_once` · `start_transition` · `stop_transition` · `create_persona` · `scaffold_tool_net` · `invoke_tool_net` |
| **Observability** | `net_overview` · `query_tokens` · `event_trail` |

Plus **resources** (`agenticnets://models`, `agenticnets://templates`, `agenticnets://docs/{concepts,arcql,recipes,security}`)
and **prompts** (`setup-working-memory`, `work-dev-team-backlog`, `capture-session`, `debug-net`).
The server also ships rich `instructions` at initialize, so your client knows how to use
Agentic-Nets well without reading any docs.

## Starter templates

| Template | What you get |
|---|---|
| `working-memory` | Memory places + link graph + an **always-on LLM distiller** (raw inbox capture → durable note) — the second-brain setup. |
| `dev-team` | **Token-free development pipeline** (backlog → ready → in-progress → review → done, WIP limits, daily digest) where *your connected agent is the worker* — the net provides persistence, state, and audit; zero server-side LLM cost. |
| `brain` | Divergent ideation: topic inbox → LLM panel → critic pass → vetted shortlist (this one runs server-side LLM calls). |
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

### Model scoping

Every tool call is validated against `AGENTICOS_MODELS` **inside this server** — out-of-list models
return `MODEL_NOT_ALLOWED`; with a single configured model, tools don't even expose a `model`
parameter. Honest boundary: the underlying gateway credential is not model-scoped (the platform has
no per-model authorization yet), so this protects against client/LLM mistakes and prompt injection —
not against a malicious operator of this process.

### Readonly mode

`AGENTICOS_MODE=readonly` registers **only** the read tools (`memory_recall`, `memory_graph`,
`net_overview`, `query_tokens`, `event_trail`) *and* authenticates with the gateway's
`agenticos-readonly` client — mutations are rejected by the gateway itself, not just by this server.
Point `AGENTICOS_ADMIN_SECRET` at the readonly client's secret.

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
