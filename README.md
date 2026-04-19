# Agentic-Nets

> **BETA — USE AT YOUR OWN RISK.** In active development; may contain bugs,
> incomplete features, and breaking changes. No warranty. See
> [LICENSE.md](LICENSE.md) and [PROPRIETARY-EULA.md](PROPRIETARY-EULA.md).

**Governed multi-agent runtime. Your agents stop running naked.**

Every agent lives inside a formal Petri net. The net's topology defines
exactly what that agent can *see*, *do*, and *remember*. Four role-scoped
autonomy levels (`r---` → `rwxh`). Token-level audit trail on every firing.
A crystallization path from agent reasoning into deterministic code, on the
same graph, without redeploy.

**Full docs and install chapter:** [agentic-nets.com](https://agentic-nets.com) *(coming soon — for now see the [Install chapter in-repo](#-install-in-5-minutes))*.

---

## It's 3 AM

An agent you deployed last week is running autonomously. It's calling your
customer database. It's pushing code. It's executing shell commands on a
payment server. The logs say it did 27 tasks and made 41 API calls.

Then your phone buzzes. The agent hit a rate limit, retried 43 times, burned
$200 in credits. Worse, it opened a PR overwriting a critical config file.
CI picked it up. Deployment started. Nobody was watching.

You want to understand what happened. You open the conversation. It's gone.
The session expired. The agent's reasoning — *why* it retried, *what* data
it saw, *what* alternatives it considered — all vanished. The logs show
**what** happened, not **why**.

This is the state of most agent frameworks today. They solve the *"how do I
call an LLM"* problem brilliantly and leave three problems unsolved:
**invisible state**, **ephemeral memory**, **ungoverned execution**.
Agentic-Nets is built to solve exactly those three.

---

## ⚡ Install in 5 minutes

You need Docker Desktop and one of: an Anthropic API key **or** local Ollama.

```bash
# 1. Download the compose file and env template
mkdir agenticnetos && cd agenticnetos
curl -LO https://raw.githubusercontent.com/alexejsailer/agentic-nets/main/deployment/docker-compose.hub-only.yml
curl -LO https://raw.githubusercontent.com/alexejsailer/agentic-nets/main/deployment/.env.template
cp .env.template .env

# 2. Edit .env — pick ONE provider:
#    (a) LLM_PROVIDER=claude + ANTHROPIC_API_KEY=sk-ant-...   ← recommended
#    (b) LLM_PROVIDER=ollama + OLLAMA_MODEL=llama3.2          ← free/offline
#        (first run `ollama pull llama3.2` on your host)

# 3. Start the stack
docker compose -f docker-compose.hub-only.yml up -d

# 4. Deploy the onboarding agent (one time per environment)
curl -LO https://raw.githubusercontent.com/alexejsailer/agentic-nets/main/scripts/deploy-first-net-buddy.sh
bash deploy-first-net-buddy.sh

# 5. Open the GUI and talk to an agent
open http://localhost:4200
```

**You don't write any code.** You open the chat panel, say something like
*"I want a net that fetches HN top stories every hour and summarizes each one
with an LLM"*, and a team of four governed agents (PM, Architect, QA, DevOps)
builds the net for you, deploys it, and hands you the URL.

Detailed walkthrough with screenshots and troubleshooting:
**[agentic-nets.com/install](https://agentic-nets.com/install)** *(coming soon)*.

---

## What makes this different

|  | Prompt-with-tools frameworks | Agentic-Nets |
|---|---|---|
| **What can this agent see?** | Whatever you paste into context | Only the tokens in its inbound places |
| **What can this agent do?** | Whatever tools you register | Only tools its role unlocks (`r---` → `rwxh`) |
| **Where do its outputs go?** | Back to you, mixed with reasoning | Typed tokens in declared outbound places |
| **What did it actually do?** | Chat transcript | Token trail with full provenance |
| **How does it get cheaper?** | It doesn't | Crystallization — agent steps collapse into deterministic transitions |

Hallucination isn't prevented by prompt engineering; it's prevented by the
graph.

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

Executor agents use **egress-only polling** — firewall-friendly, deployable
anywhere:

| Mode | When | Executor polls | Auth |
|------|------|----------------|------|
| **Direct** | Same network as master | `http://agentic-net-master:8082` | None (internal) |
| **Gateway** | Remote / different network | `http://<gateway-host>:8083` | JWT (auto-acquired) |

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

Full architecture deep dive: see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Repository structure

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

## Licensing

Dual-license model:

- **Source code in this repo** — [BSL 1.1](LICENSE.md). Free for development,
  testing, personal, educational, evaluation. Commercial production use
  requires a commercial license. Converts to Apache 2.0 on 2030-02-22.
- **Closed-source Docker Hub images** (`agenticos-node`, `agenticos-master`,
  `agenticos-gui`) — [Proprietary EULA](PROPRIETARY-EULA.md). Free for
  personal, educational, evaluation, non-commercial use. Commercial use
  requires contact at alexejsailer@gmail.com.

**ALL SOFTWARE IS PROVIDED AS-IS WITH ABSOLUTELY NO WARRANTY.**

---

## Contact

- **Commercial licensing**: alexejsailer@gmail.com
- **Website & blog**: https://alexejsailer.com
- **Hosted docs**: https://agentic-nets.com *(coming soon)*
- **Issues**: https://github.com/alexejsailer/agentic-nets/issues
- **Contributing**: see [CONTRIBUTING.md](CONTRIBUTING.md)

---

> _Much of this codebase was built with AI pair programming. Commits
> co-authored by `Claude Opus 4.7 (1M context)` are part of that story — it
> felt right for a governed multi-agent runtime to be built, in part, by
> agents. See [CHANGELOG.md](CHANGELOG.md) for the human-curated release notes._

Copyright (c) 2025-2026 Alexej Sailer. All rights reserved.
