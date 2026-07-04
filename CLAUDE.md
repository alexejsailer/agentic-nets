# AgenticNetOS Agentic-Nets — Open-Source Repository

## Overview

This is the **public, open-source** part of [AgenticNetOS](https://alexejsailer.com) — the Agentic Workflow OS. It contains the open-source services, deployment configurations, and monitoring stack.

Closed-source core services (node, master, gui) are distributed as pre-built Docker Hub images and governed by `PROPRIETARY-EULA.md`. All source code in this repo is licensed under `LICENSE.md` (BSL 1.1).

## Changelog rotation

`CHANGELOG.md` at the repo root holds **only the current calendar quarter's**
releases. Older quarters live under [`changelogs/`](changelogs/) — see
[`changelogs/README.md`](changelogs/README.md) for the rotation rule and
quarterly archive index. The full convention is documented in the workspace
root [`../CLAUDE.md`](../CLAUDE.md) under "Release Notes". Do not rename or
move `CHANGELOG.md` — Jenkins `prepare-release` reads it by exact path.

## Repository Structure

```
agentic-nets/
├── LICENSE.md                         # BSL 1.1 (open-source code)
├── PROPRIETARY-EULA.md                # EULA for Docker Hub images (node, master, gui)
├── README.md
├── .gitignore
├── .dockerignore
│
├── agentic-net-gateway/                  # OAuth2 API gateway (Spring Boot, Java 21)
├── agentic-net-executor/                 # Command executor (Spring Boot, Java 21)
├── agentic-net-vault/                    # Secrets management via OpenBao (Spring Boot, Java 21)
├── agentic-net-cli/                      # CLI tool (TypeScript, Node.js 22)
├── agentic-net-chat/                     # Telegram bot (TypeScript, Node.js 22)
├── agentic-net-mcp/                      # MCP server (TypeScript, Node.js 22)
├── sa-blobstore/                      # Blob storage (Spring Boot, Java 21)
│
├── deployment/
│   ├── docker-compose.yml             # Hybrid: Hub images (closed) + local builds (open)
│   ├── docker-compose.hub-only.yml    # All services from Docker Hub
│   ├── .env.template                  # Environment config template (no secrets)
│   ├── dockerfiles/
│   │   ├── Dockerfile.agentic-net-gateway
│   │   ├── Dockerfile.agentic-net-executor
│   │   ├── Dockerfile.agentic-net-cli
│   │   ├── Dockerfile.agentic-net-chat
│   │   ├── Dockerfile.agentic-net-vault
│   │   └── Dockerfile.sa-blobstore
│   └── scripts/
│       └── build-and-push.sh          # Build & push open-source images only
│
└── monitoring/
    ├── config/
    │   ├── otel-collector-config.yaml
    │   ├── prometheus.yaml
    │   └── tempo.yaml
    └── grafana-provisioning/
        ├── dashboards/
        └── datasources/
```

## Services

### agentic-net-gateway (Port 8083)

**Purpose**: OAuth2 API gateway for secure distributed access.

- **Technology**: Spring Boot 3.5.5, Spring Security with JWT
- **Routes**: Master (`/api/...`) and Node (`/node-api/...`)
- **Auth**: JWT-based with auto-token acquisition, admin secret for bootstrap
- **Key role**: Enables executor, CLI, and chat to reach master/node across network boundaries
- **Build**: `cd agentic-net-gateway && ./mvnw clean package -DskipTests`

### agentic-net-executor (Port 8084)

**Purpose**: Distributed command execution service. Executes shell commands on behalf of command-type transitions.

- **Technology**: Spring Boot 3.5.5, Java 21
- **Execution**: `ProcessBuilder("bash", "-c", command)`, supports `exec` and `script` modes
- **Multi-model**: Composite `modelId:transitionId` keys, discovers models via master API
- **Build**: `cd agentic-net-executor && ./mvnw clean package -DskipTests`

#### Dual Polling Mode

The executor uses **egress-only polling** — it reaches out to fetch work, never receives inbound connections:

| Mode | When | Polls | Auth |
|------|------|-------|------|
| **Direct** | Same network as master | `http://agentic-net-master:8082` | None (internal) |
| **Gateway** | Remote / different network | `http://<gateway>:8083` | JWT (auto-acquired) |

```bash
# Direct mode (default in docker-compose.yml)
MASTER_HOST=agentic-net-master
MASTER_PORT=8082

# Gateway mode (remote deployment)
AGENTICOS_GATEWAY_URL=https://your-gateway-host:8083
AGENTICOS_GATEWAY_SECRET_FILE=/app/gateway-data/jwt/admin-secret
```

#### CRITICAL — Stdin Blocking Issue

When running CLI tools via the executor, always redirect stdin:
```bash
# WRONG — Will hang indefinitely
claude -p 'prompt'

# CORRECT — Redirect stdin to prevent blocking
claude -p 'prompt' --no-session-persistence < /dev/null
```

#### Command Token Schema

```json
{
  "kind": "command",
  "id": "unique-cmd-id",
  "executor": "bash",
  "command": "exec",
  "args": {
    "command": "your-shell-command-here",
    "workingDir": "/path/to/directory",
    "timeoutMs": 60000,
    "captureStderr": true,
    "env": {"KEY": "value"}
  },
  "expect": "text",
  "meta": {"correlationId": "req-001"}
}
```

#### Command Result Format

```json
{
  "batchPrefix": "transition-id-timestamp",
  "batchResults": [{
    "executor": "bash",
    "results": [{"id": "cmd-id", "status": "SUCCESS", "output": {"exitCode": 0, "stdout": "...", "stderr": "", "success": true}, "durationMs": 15}],
    "totalCount": 1, "successCount": 1, "failedCount": 0
  }],
  "success": true
}
```

### agentic-net-cli

**Purpose**: Command-line interface for AgenticNetOS operations.

- **Technology**: TypeScript, Node.js 22, ESM bundle via tsup
- **Build**: `cd agentic-net-cli && npm install && npx tsup` (105KB ESM bundle)
- **Run**: `node dist/bin/agenticos.js` or link via `npm link`
- **Dual mode**: `--direct` (node:8080 + master:8082) or gateway (:8083 with JWT)
- **LLM providers**: `anthropic`, `claude-code`, `codex`, `ollama`, routed
- **RoutedLlmProvider**: Routes between "worker" (cheap) and "thinker" (reasoning) models
- **Claude Code provider**: `--provider claude-code` uses `claude -p` with `--tools ''`
- **Tool use via text**: Embeds `<tool_call>` XML protocol in system prompt
- **License**: `"SEE LICENSE IN LICENSE.md"` in package.json

### agentic-net-chat

**Purpose**: Telegram bot integration for conversational workflows.

- **Technology**: TypeScript, Node.js 22, grammy library
- **Build**: `cd agentic-net-chat && npm install && npx tsup`
- **Dependency**: `@agenticos/cli` via `file:../agentic-net-cli` (monorepo workspace link)
- **Sessions**: Auto-expiration (4-hour TTL), auto-compaction (30K token threshold)
- **Limits**: 100 iterations, 100 tool calls, 3 think calls, 50 consecutive same-tool calls
- **License**: `"SEE LICENSE IN LICENSE.md"` in package.json

**Note on Docker build context**: The chat Dockerfile uses the repo root as build context (not just `agentic-net-chat/`) because it needs to copy `agentic-net-cli/` for the workspace dependency.

### agentic-net-mcp

**Purpose**: MCP (Model Context Protocol) server — exposes an AgenticNetOS stack to any MCP client
(Claude Code, Claude Desktop, Cursor, agent frameworks) as **persistent working memory that runs**
plus a net-building workbench. Design doc: `agentic-net-mcp/DESIGN.md`.

- **Technology**: TypeScript, Node.js 22, `@modelcontextprotocol/sdk`; reuses `@agenticos/cli`'s
  `GatewayClient`/`MasterApi`/`NodeApi`/`ToolExecutor` via `file:../agentic-net-cli` (bundled inline
  by tsup `noExternal` — same pattern as chat, including the repo-root Docker build context)
- **Build / test**: `cd agentic-net-mcp && npm install && npx tsup && npm test` (32 hermetic vitest
  tests: scope guard, blueprint invariants, protocol registration shapes, template executor)
- **Transports**: stdio (default; `npx @agenticnets/mcp`, `claude mcp add`) and streamable HTTP
  (`AGENTICOS_MCP_TRANSPORT=http`, bearer-token-protected `POST /mcp` — used by the compose service)
- **Tools (103 = 32 curated lowercase + 71 native UPPERCASE)**. Native layer = FULL platform parity:
  every ToolExecutor tool (the same catalog agent transitions use in-net) auto-registered from the
  CLI's `getAvailableTools(FULL)` + `buildToolSchemas` with real descriptions/schemas — new platform
  tools appear automatically after a catalog sync; excluded only `THINK`/`DONE`/`FAIL` (agent-loop
  primitives); rw-mode only; browsable via the `agenticnets://tool-catalog` resource. Curated layer:
  memory layer `memory_write` / `memory_recall` / `memory_link` / `memory_graph`;
  net-building `deploy_template`, `create_net`, `add_place`, `add_transition` (kind-aware pre-wired
  inscriptions: map/llm/http/command/**agent**/link), `set_schedule`, `fire_once`, `start/stop_transition`,
  `create_persona`, **`spawn_persona`** (complete self-driving agent-persona net — charter + task inbox +
  started `agent` transition + output; run several in parallel), `scaffold_tool_net`, `invoke_tool_net`,
  **`crystallize_session`** (record a session's summary + steps to memory AND bake the steps into a
  replayable command tool-net);
  model control **`pause_model`** (kill switch — stops ALL running transitions, writes an audit
  `pause-record` token to `p-mcp-control`) / **`resume_model`** (restores exactly the paused set;
  command lanes re-register RUNNING on the executor's next poll, ~seconds — trust `resumedCount`);
  model lifecycle **`list_models`** (all models + per-connection `allowed` flag) / **`create_model`**
  (mint a NEW model + optional template deploy; joins the session allowlist so scope.multiModel becomes
  true and every tool exposes the `model` param even for a 1-model config; gated by
  `AGENTICOS_ALLOW_MODEL_CREATE`, rw-only) — so the COMPLETE AgenticOS feature set (models/sessions/
  nets/tokens) is reachable via MCP; **`DELETE_TRANSITION`** deregisters an orphaned runtime transition
  (stop+remove inscription/status/assignment; DELETE_NET gained `deleteTransitions:true`) — needed a
  new CLI `MasterApi.deleteTransition` (DELETE /runtime/transitions/{id}); **known gap**: node admin
  model *removal* 500s/404s through the gateway proxy (create works, remove deferred);
  NetHub **`hub_publish`** (net/session/**model** artifact, versioned, credential-scrubbed; `tokens`=
  none|config|all where config = *-config/*-charter place tokens + `config:"true"`-marked tokens) /
  **`hub_search`** (local or a peer via `remote`) / **`hub_install`** (model-kind ⇒ create_new model +
  grantModel) / **`hub_add_remote`** (peer instance URL; P2P federation) — backed by master `/api/hub`
  (HubController/HubService/HubRemoteStore/HubRemoteClient) over the existing package registry; the
  7 native `HUB_*` catalog tools auto-appear too. Gateway `gateway.hub.public-catalog`
  (`AGENTICOS_HUB_PUBLIC_CATALOG`, default false) opt-in-exposes anonymous GET `/api/hub/public/**` +
  `/api/packages/**` (folded under the same flag — default is "no token ⇒ nothing");
  client-hosted execution **`host_transition`** / **`unhost_transition`** (an llm/agent transition
  built with `start:false` is NEVER on master — the MCP process itself executes it via the CLI's
  `executeTransitionLocally` on `AGENTICOS_LLM_PROVIDER` (default `claude-code` = local `claude`
  binary; also ollama/anthropic/openai + `AGENTICOS_LLM_MODEL`/`_TIER`); `mode:watch` polls the
  inbox, `mode:once` single-shot; stats in `net_stats.hosted`; hosted lanes run only while the
  session is connected — tokens wait safely otherwise);
  observability/debugging `net_overview`, `query_tokens`, `event_trail`, **`net_stats`** (LLM
  consumption + running/error transitions + **`scheduled`** cron/interval list + `paused` flag +
  tool-net usage + recent errors — the no-logs cockpit),
  **`verify_inscription`** / **`dry_run_transition`** / **`diagnose_transition`** (per-transition
  diagnosis; rw-only — they travel as POST, readonly registers only `net_stats` from this group).
  The server `instructions` + recipes teach clients: 6-field cron scheduling (nets act overnight —
  always tell the user what you armed), spawning full Claude Code instances via command transitions
  (`claude -p '…' --allowedTools … --no-session-persistence < /dev/null` — stdin redirect mandatory),
  and the model-control contract ("switch it off" ⇒ `pause_model`, verify `net_stats.paused`).
  **agent-persona note**: `spawn_persona` workers auto-route via `autoEmit:true`, so `verify_inscription`
  reports a benign `MISSING_EMIT` warning on them (expected, not a failure — proven: task in → agent
  fires → result auto-lands in the output place).
- **Starter templates** (`deploy_template`, idempotent; params via `agenticnets://templates`):
  `working-memory` (memory places + link graph + always-on LLM distiller; param `distillPrompt`),
  `dev-team` (token-free pipeline — the CONNECTED AGENT is the worker; param `digestCron`),
  `brain` (LLM panel + critic; params `panelPrompt`/`criticPrompt`), `watcher` (zero-LLM cron
  sentinel: probe url → log + webhook alert on non-200; params `url`/`webhook`/`cron`/`label`),
  `blank`
- **Claude Code hooks** (`agentic-net-mcp/hooks/`, fail-open, config `~/.agenticnets/hooks.env`):
  `agenticnets-recall.sh` (SessionStart → injects newest decisions/notes as additionalContext) +
  `agenticnets-capture.sh` (SessionEnd → session summary token to `p-mem-inbox`; distiller makes it
  durable). Gotcha pair: hook stdin must be `cat`-ed into a var BEFORE `python3 - <<HEREDOC` (the
  heredoc consumes stdin), and master's token POST body is `{"data":{...}}` (TokenCreateRequest).
- **Teach-the-client**: rich `instructions` at initialize + `agenticnets://docs/{concepts,arcql,recipes,security}`
  resources + prompts (`setup-working-memory`, `work-dev-team-backlog`, `capture-session`, `debug-net`)
- **License**: `"SEE LICENSE IN LICENSE.md"` in package.json

#### Configuration (env-first, no config files)

| Env | Meaning | Default |
|---|---|---|
| `AGENTICOS_MODELS` | **Required.** Model allowlist (comma-separated); first = default. Single model ⇒ tools expose NO `model` param; multiple ⇒ optional `model` validated per call (`MODEL_NOT_ALLOWED` otherwise) | — (fail-fast) |
| `AGENTICOS_GATEWAY_URL` | Gateway base (all traffic goes through `/api` + `/node-api`) | `http://localhost:8083` |
| `AGENTICOS_ADMIN_SECRET` / `AGENTICOS_GATEWAY_SECRET_FILE` | Client secret for the mode's client id | — (required) |
| `AGENTICOS_MODE` | `rw` \| `readonly` — readonly registers ONLY the 6 GET-based read tools (`memory_recall`, `memory_graph`, `net_overview`, `query_tokens`, `event_trail`, `net_stats`) AND authenticates as `agenticos-readonly`, so the gateway itself 403s mutations (the POST-based `diagnose/dry-run/verify` diagnostics are rw-only) | `rw` |
| `AGENTICOS_SESSION` | Session name for MCP-created nets/places | `mcp` |
| `AGENTICOS_NODE_HOST` | Host injected into inscription presets/postsets (`{model}@{host}`); in-compose: `agentic-net-node:8080` | `localhost:8080` |
| `AGENTICOS_MCP_TRANSPORT` / `AGENTICOS_MCP_HTTP_PORT` / `AGENTICOS_MCP_HTTP_TOKEN` | HTTP transport toggle, port, required bearer token | `stdio` / `8091` / — |

Compose keys (`deployment/.env`): `AGENTICOS_MCP_MODELS` / `_MODE` / `_SESSION` / `_HTTP_TOKEN`
(generate: `openssl rand -hex 24`), `AGENTIC_NET_MCP_PORT` (8091). Service is opt-in:
`COMPOSE_PROFILES=mcp docker compose -f docker-compose.hub-only.yml up -d agentic-net-mcp`.

Ready-to-paste (Claude Code, local stack):
```bash
claude mcp add agenticnets \
  -e AGENTICOS_GATEWAY_URL=http://localhost:8083 \
  -e AGENTICOS_ADMIN_SECRET=$(cat deployment/data/gateway/jwt/admin-secret) \
  -e AGENTICOS_MODELS=my-memory \
  -- npx @agenticnets/mcp
```

**Deliberately NOT configurable**: the tool surface itself (two fixed layers — curated lowercase +
full native catalog; the native list tracks the platform catalog automatically, not an env toggle),
the `p-mem-*` memory-place conventions (templates upgrade the same places the tools write to), and
the engine-gotcha defaults baked into inscriptions (non-empty preset arcql, llm `timeoutMs` 240s,
catch-all emits). **Scoping honesty**: the allowlist is enforced in-process; the underlying gateway
credential is NOT model-scoped (no per-model authz exists in the platform yet) — it protects against
client/LLM mistakes and prompt injection, not a malicious operator of the MCP process.

### agentic-net-vault (Port 8085)

**Purpose**: Secrets management service for transition credentials. Wraps OpenBao (open-source Vault fork) as the secrets backend.

- **Technology**: Spring Boot 3.5.5, Java 21, spring-vault-core 3.1.1
- **Backend**: OpenBao (MPL 2.0, API-compatible with HashiCorp Vault)
- **Build**: `cd agentic-net-vault && ./mvnw clean package -DskipTests`
- **KV v2 path**: `secret/agenticos/credentials/{modelId}/{transitionId}`
- **API**: CRUD for transition credentials (`PUT/GET/DELETE /api/vault/{modelId}/transitions/{transitionId}/credentials`)
- **Auth**: Token auth (dev mode) or AppRole (production)
- **Network**: `agenticnetos-backend` only — not exposed to host

### sa-blobstore (Port 8090)

**Purpose**: Distributed blob storage service.

- **Technology**: Spring Boot, Java 21
- **Build**: `cd sa-blobstore && ./mvnw clean package -DskipTests`
- **Dockerfile**: Multi-stage with production and development targets

## Deployment

### Compose Files

Two deployment modes in `deployment/`:

| File | Description |
|------|-------------|
| `docker-compose.yml` | **Hybrid** — Closed-source from Hub, open-source built locally |
| `docker-compose.hub-only.yml` | **All pre-built** — Everything from Docker Hub |

### Networks

| Network | Services |
|---------|----------|
| `agenticnetos-backend` | node, master, executor, gateway, vault, openbao, monitoring, registry |
| `agenticnetos-clients` | gateway, gui, cli, chat |

Gateway bridges both networks.

### Service Sources

| Service | Hybrid Compose | Hub-Only Compose |
|---------|---------------|-----------------|
| agentic-net-node | `image:` (Hub) | `image:` (Hub) |
| agentic-net-master | `image:` (Hub) | `image:` (Hub) |
| agentic-net-gui | `image:` (Hub) | `image:` (Hub) |
| agentic-net-gateway | `build:` (local) | `image:` (Hub) |
| agentic-net-executor | `build:` (local) | `image:` (Hub) |
| agentic-net-vault | `build:` (local) | `image:` (Hub) |
| agentic-net-cli | `build:` (local) | `image:` (Hub) |
| agentic-net-chat | `build:` (local) | `image:` (Hub) |
| sa-blobstore | `build:` (local) | `image:` (Hub) |

### Quick Start

```bash
cd deployment
cp .env.template .env
# Edit .env — at minimum set LLM_PROVIDER and API keys

# Option A: All pre-built
docker compose -f docker-compose.hub-only.yml up -d

# Option B: Hybrid (build open-source locally)
docker compose up -d
```

### Gateway Auto-Auth

Gateway generates an admin secret on first startup. CLI and Chat mount the gateway data volume read-only to auto-acquire JWT tokens:
```yaml
volumes:
  - ./data/gateway:/app/gateway-data:ro
```

### Environment Configuration

Copy `.env.template` to `.env`. Key settings:

```bash
# LLM
LLM_PROVIDER=ollama                              # or "claude"
ANTHROPIC_API_KEY=                                # for Claude provider
OLLAMA_BASE_URL=http://host.docker.internal:11434 # for Ollama provider

# Security (auto-generated by gateway if empty)
AGENTICOS_ADMIN_SECRET=
AGENTICOS_SETTINGS_KEY=

# Telegram (optional)
TELEGRAM_BOT_ENABLED=false
TELEGRAM_BOT_TOKEN=
```

## Building & Pushing Images

```bash
# Build and push all open-source services
./deployment/scripts/build-and-push.sh 1.0.0

# Dry run (build only)
./deployment/scripts/build-and-push.sh 1.0.0 --dry-run

# Single service
./deployment/scripts/build-and-push.sh 1.0.0 --only gateway
```

Services: `gateway`, `executor`, `vault`, `cli`, `chat`, `blobstore`

## Monitoring

Stack: Grafana + Prometheus + Tempo + OpenTelemetry Collector

| Service | URL | Notes |
|---------|-----|-------|
| Grafana | http://localhost:3000 | admin/admin |
| Prometheus | http://localhost:9090 | |
| Tempo | http://localhost:3200 | Distributed tracing |

All AgenticNetOS services export metrics and traces via OpenTelemetry (OTLP to `otel-collector:4318`).

Configs in `monitoring/config/`, Grafana dashboards in `monitoring/grafana-provisioning/`.

## Port Allocation

| Port | Service |
|------|---------|
| 8080 | agentic-net-node (closed-source, Hub) |
| 8082 | agentic-net-master (closed-source, Hub) |
| 8083 | agentic-net-gateway |
| 8084 | agentic-net-executor |
| 8085 | agentic-net-vault |
| 4200 | agentic-net-gui (closed-source, Hub) |
| 8090 | sa-blobstore |
| 8091 | agentic-net-mcp (HTTP transport, opt-in `mcp` profile) |
| 3000 | Grafana |
| 9090 | Prometheus |
| 3200 | Tempo |
| 4317/4318 | OpenTelemetry Collector (gRPC/HTTP) |

## Licensing Model

| What | License | File |
|------|---------|------|
| Source code in this repo | BSL 1.1 | `LICENSE.md` |
| Docker images: node, master, gui | Proprietary EULA | `PROPRIETARY-EULA.md` |

**BSL 1.1 summary**: Free for non-production use (dev, test, personal, education). Commercial production use requires a license. Converts to Apache 2.0 on 2030-02-22.

**EULA summary**: Free for personal/educational/non-commercial use. Commercial use requires contacting alexejsailer@gmail.com.

**Both carry strong NO WARRANTY / BETA disclaimers.**

## Relationship to core/

This repo (`agentic-nets/`) was split from the AgenticNetOS monorepo. The open-source services were **moved** here (not copied). The private repo at `../core/` retains the closed-source services and full git history.

The closed-source services (node, master, gui) are consumed here only as Docker Hub images — their source code is not in this repository.

## Key Lessons Learned

- Docker Compose prefixes network names with project name — use `name:` in network definition to get exact names
- `agentic-net-chat` Dockerfile needs repo root as build context because of `file:../agentic-net-cli` dependency
- Executor stdin blocking: always redirect `< /dev/null` when running CLI tools via command transitions
- Gateway auto-generates admin secret — CLI/chat mount gateway volume read-only for auto-auth
- `.env` files must never be committed (`.gitignore` blocks them) — use `.env.template`
