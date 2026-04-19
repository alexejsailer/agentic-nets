# AgenticNets

> **BETA — USE AT YOUR OWN RISK.** In active development; may contain bugs,
> incomplete features, and breaking changes. No warranty. See
> [LICENSE.md](LICENSE.md) and [PROPRIETARY-EULA.md](PROPRIETARY-EULA.md).

**AgenticNets is a multi-agent framework for agentic orchestration.**

Agents live inside a Petri-net coordination fabric — each one with its own
role, LLM tier, and provider. They communicate through typed token places,
discover and invoke each other's capabilities through a shared tool-net
marketplace, and scale from one autonomous worker to a heterogeneous team
without glue code.

This repository ships the open-source services, deployment stack, tool
containers, and monitoring. The closed-source core (state engine,
orchestration master, visual editor) is distributed as signed Docker Hub
images under a separate EULA.

> _Much of this codebase was built with AI pair programming. Commits
> co-authored by `Claude Opus 4.7 (1M context)` are part of that story — it
> felt right for a multi-agent framework to be built, in part, by agents.
> See [CHANGELOG.md](CHANGELOG.md) for the human-curated release notes._

---

## Why AgenticNets

Most multi-agent frameworks (LangGraph, AutoGen, CrewAI) make you code the
agent interactions. AgenticNets makes coordination **declarative**:

- **Typed shared state.** Places hold tokens of known shape. Agents subscribe
  via ArcQL queries; coordination is a graph, not a chain of function calls.
- **Per-agent LLM tier.** Every agent picks its own `toolsModel` +
  `thinkingModel` + `activeTier` pointer. Orchestrators on Opus, workers on
  Haiku, all in the same model — cost scales with task difficulty, not with
  framework commitment.
- **Capability marketplace.** Agents discover each other's skills at runtime
  through tool-nets: `LIST_TOOL_NETS` → `DESCRIBE_TOOL_NET` →
  `INVOKE_TOOL_NET`. New tools can be scaffolded by other agents.
- **Firewall-friendly execution.** Executor agents poll outward only — no
  inbound ports, no VPN, no port-forwarding. Ship agents to a home NAS, a
  corporate laptop, or a Raspberry Pi behind NAT.
- **Heterogeneous providers.** Ollama (local or cloud), Anthropic API,
  OpenAI API, Claude Code CLI (no API key — uses OAuth), Codex CLI. Pick
  per-agent, per-fire.

---

## Architecture

```
                    +-------------------+
                    | agentic-net-gui   |  Closed-source (Docker Hub)
                    |     (4200)        |  visual Petri-net editor
                    +--------+----------+
                             |
                    +--------v----------+
                    | agentic-net-gateway  |  Open-source (this repo)
                    |     (8083)        |  OAuth2 + JWT
                    +---+----------+----+
                        |          |
              +---------v--+  +----v-----------+
              | agentic-net  |  | agentic-net     |  Closed-source (Docker Hub)
              | master       |  | node            |  orchestration + state engine
              |  (8082)      |  |  (8080)         |
              +----+---------+  +-----+-----------+
                   |                  |
          +--------+-----+     +------+------+
          |              |     |             |
  +-------v------+  +----v-----+--+   +------v------+
  | agentic-net     |  | agentic-net    |   | sa-blobstore |
  | executor       |  | chat          |   |   (8090)    |
  |  (8084)        |  | (Telegram)    |   |             |
  +----------------+  +--------------+   +-------------+

          +------------------------------+
          |  agentic-net-cli             |  heterogeneous LLM providers
          |  (your terminal)             |  per-session role config
          +------------------------------+

          +------------------------------+
          |  agentic-net-tools/          |  tool containers (Docker)
          |  (crawler, echo, reddit,     |  agents start/invoke/stop on demand
          |   rss, search, secured-api)  |
          +------------------------------+
```

### Agent roles on the wire

Every agent runs under a **capability role** (`rwxhl` Unix-style flags):

| Flag | Capability | Typical tools available |
|---|---|---|
| `r` | Read | `QUERY_TOKENS`, `LIST_PLACES`, `GET_NET_STRUCTURE`, `DESCRIBE_TOOL_NET`, discovery |
| `w` | Write | + `CREATE_TOKEN`, `SET_INSCRIPTION`, `CREATE_NET`, `TAG_SESSION`, `REGISTER_TOOL_NET` |
| `x` | Execute | + `DEPLOY_TRANSITION`, `START_TRANSITION`, `FIRE_ONCE`, `INVOKE_TOOL_NET`, `DELEGATE_TASK` |
| `h` | HTTP | + external HTTP calls |
| `l` | Logs | + event-line observability |

Pick minimal. A read-only diagnostic agent gets `r----`; a full coordinator
gets `rwxhl`. The runtime refuses tool calls outside the configured role.

### Executor polling modes

Executor agents use **egress-only polling** — they reach out to fetch work
and never receive inbound connections. This makes them firewall-friendly and
deployable anywhere:

| Mode | When | Executor polls | Auth |
|------|------|----------------|------|
| **Direct** | Same network as master | `http://agentic-net-master:8082` | None (internal) |
| **Gateway** | Remote / different network | `http://<gateway-host>:8083` | JWT (auto-acquired) |

Configure via environment variables:

```bash
# Direct mode (default in docker-compose.yml)
MASTER_HOST=agentic-net-master
MASTER_PORT=8082

# Gateway mode (remote deployment)
AGENTICOS_GATEWAY_URL=https://your-gateway-host:8083
AGENTICOS_GATEWAY_SECRET_FILE=/app/gateway-data/jwt/admin-secret
```

### Open-source services (this repo)

| Service | Purpose | Port |
|---------|---------|------|
| **agentic-net-gateway** | OAuth2 API gateway with JWT auth, rate limits, read-only scopes | 8083 |
| **agentic-net-executor** | Distributed command execution agent, polls master direct or via gateway | 8084 |
| **agentic-net-vault** | Secrets management (OpenBao wrapper) for agent-transition credentials | 8085 |
| **agentic-net-cli** | Command-line agent with multi-provider LLM routing and tool-catalog sync | — |
| **agentic-net-chat** | Telegram-facing agent with streaming tool-call batches and `/verbose` toggle | — |
| **sa-blobstore** | Distributed blob storage for large tokens, artifacts, and knowledge content | 8090 |
| **agentic-net-tools/** | Tool containers agents start on demand (crawler, echo, reddit, rss, search, secured-api) | dynamic |

### Closed-source services (Docker Hub)

| Image | Purpose | Port |
|-------|---------|------|
| `alexejsailer/agenticos-node` | Event-sourced state engine, tree-structured persistence, ArcQL queries | 8080 |
| `alexejsailer/agenticos-master` | Orchestration, LLM integration, transition engine, agent runtime | 8082 |
| `alexejsailer/agenticos-gui` | Angular visual editor with drag-drop Petri-net design | 4200 |

These images are governed by the [Proprietary EULA](PROPRIETARY-EULA.md).

---

## Quick Start

### Option 1: All Pre-Built (Fastest)

Pull everything from Docker Hub — no building required.

```bash
cd deployment
cp .env.template .env
# Edit .env with your settings (LLM provider, API keys, etc.)
docker compose -f docker-compose.hub-only.yml up -d
```

### Option 2: Hybrid (Build Open-Source Locally)

Closed-source images from Docker Hub, open-source services built from source.

```bash
cd deployment
cp .env.template .env
# Edit .env with your settings
docker compose up -d
```

### Access points

| Service | URL |
|---------|-----|
| GUI | http://localhost:4200 |
| Gateway API | http://localhost:8083 |
| Grafana | http://localhost:3000 (admin/admin) |
| Prometheus | http://localhost:9090 |

### First agent run

```bash
# From the terminal, fire a one-shot agent query via the CLI
cd agentic-net-cli
npm install && npx tsup
export AGENTICOS_ADMIN_SECRET=$(cat ../deployment/data/gateway/jwt/admin-secret)
node dist/bin/agenticos.js ask --provider claude-code --tier low --role r \
  "List all sessions in the current model."
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the multi-agent coordination model
in depth.

---

## Repository Structure

```
agentic-nets/
├── LICENSE.md                    # BSL 1.1 (open-source code)
├── PROPRIETARY-EULA.md           # EULA for Docker Hub images
├── README.md                     # (this file)
├── ARCHITECTURE.md               # Deep dive: transitions, ArcQL, coordination
├── CHANGELOG.md                  # Human-curated release notes
├── CONTRIBUTING.md               # How to contribute
│
├── agentic-net-gateway/          # OAuth2 API gateway (Spring Boot)
├── agentic-net-executor/         # Command executor (Spring Boot)
├── agentic-net-vault/            # Secrets wrapper for OpenBao (Spring Boot)
├── agentic-net-cli/              # CLI agent (TypeScript/Node)
├── agentic-net-chat/             # Telegram-facing agent (TypeScript/Node)
├── sa-blobstore/                 # Distributed blob storage (Spring Boot)
├── agentic-net-tools/            # Tool containers (Docker)
│
├── deployment/
│   ├── docker-compose.yml        # Hybrid: Hub images + local builds
│   ├── docker-compose.hub-only.yml  # All services from Docker Hub
│   ├── .env.template             # Environment config template
│   ├── dockerfiles/              # Build files for open-source services
│   └── scripts/
│       └── build-and-push.sh     # Build & push open-source images
│
└── monitoring/
    ├── config/                   # OTel, Prometheus, Tempo configs
    └── grafana-provisioning/     # Dashboards and datasources
```

---

## Configuration

Copy `.env.template` to `.env` and configure:

### LLM provider (master-wide default)

```bash
# Local Ollama (default)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=llama3.2

# Anthropic Claude API
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

Individual agents can override the master's provider via their inscription
— see the **Two-Tier LLM Config** section of
[ARCHITECTURE.md](ARCHITECTURE.md) for per-agent model pairs and bash-mode
(Claude Code / Codex) without API keys.

### Telegram agent (optional)

```bash
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_BOT_USERNAME=your-bot-name
```

---

## Building open-source images

```bash
# Build and push all open-source services
./deployment/scripts/build-and-push.sh 1.0.0

# Dry run (build only, no push)
./deployment/scripts/build-and-push.sh 1.0.0 --dry-run

# Build a single service
./deployment/scripts/build-and-push.sh 1.0.0 --only gateway
```

---

## Monitoring

The monitoring stack includes:

- **Grafana** (http://localhost:3000) — Dashboards and visualization
- **Prometheus** (http://localhost:9090) — Metrics collection
- **Tempo** — Distributed tracing
- **OpenTelemetry Collector** — Telemetry pipeline

All services export metrics and traces via OpenTelemetry. Per-agent tool
invocations, LLM calls, and coordination events appear on the event line
and can be queried by agents with the `l` (logs) role via `QUERY_EVENTS`.

---

## Licensing

This repository uses a **dual-license model**:

### Open-source code (BSL 1.1)

All source code in this repository is licensed under the
[Business Source License 1.1](LICENSE.md):

- **Free for**: development, testing, personal, educational, evaluation.
- **Commercial production use**: requires a commercial license.
- **Change date**: 2030-02-22 (converts to Apache 2.0).

### Proprietary Docker images (EULA)

The closed-source Docker Hub images (`agenticos-node`, `agenticos-master`,
`agenticos-gui`) are governed by the
[Proprietary EULA](PROPRIETARY-EULA.md):

- **Free for**: personal, educational, evaluation, non-commercial use.
- **Commercial use**: contact alexejsailer@gmail.com.

### No warranty

**ALL SOFTWARE IN THIS PROJECT IS PROVIDED AS-IS WITH ABSOLUTELY NO WARRANTY.**
This applies to both open-source code and proprietary Docker images. See
the respective license files for full legal terms.

---

## Contact

- **Commercial licensing**: alexejsailer@gmail.com
- **Website**: https://alexejsailer.com
- **Issues**: https://github.com/alexejsailer/agentic-nets/issues
- **Contributing**: see [CONTRIBUTING.md](CONTRIBUTING.md)

---

Copyright (c) 2025-2026 Alexej Sailer. All rights reserved.
