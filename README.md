# AgetnticOS Agentic-Nets

> **BETA SOFTWARE — USE AT YOUR OWN RISK**
>
> This project is in active development. It may contain bugs, incomplete features, and breaking changes.
> There is **absolutely no warranty** of any kind. See [LICENSE.md](LICENSE.md) and [PROPRIETARY-EULA.md](PROPRIETARY-EULA.md) for details.

**Agentic-Nets** is the open-source deployment and extension layer for [AgetnticOS](https://alexejsailer.com) — the Agentic Workflow OS that combines autonomous intelligence with Petri-net control, distributed execution, and full token-level observability.

This repository contains the open-source services, deployment configurations, and monitoring stack. Closed-source core services (node, master, gui) are available as pre-built Docker images from Docker Hub.

---

## Architecture

```
                    +-------------------+
                    |   agentic-net-gui    |  Closed-source (Docker Hub)
                    |     (4200)        |
                    +--------+----------+
                             |
                    +--------v----------+
                    | agentic-net-gateway  |  Open-source (this repo)
                    |     (8083)        |
                    +---+----------+----+
                        |          |
              +---------v--+  +----v-----------+
              | agentic-net-  |  | agentic-net-      |  Closed-source (Docker Hub)
              | master     |  | node           |
              | (8082)     |  | (8080)         |
              +-----+------+  +----------------+
                    |
          +---------+---------+
          |                   |
+---------v------+  +---------v------+
| agentic-net-      |  | agentic-net-      |  Open-source (this repo)
| executor       |  | chat           |
| (8084)         |  | (Telegram)     |
+----------------+  +----------------+
```

### Executor Polling Modes

The executor uses **egress-only polling** — it reaches out to fetch work, never receives inbound connections. This makes it firewall-friendly and deployable anywhere:

| Mode | When | Executor polls | Auth |
|------|------|----------------|------|
| **Direct** | Same network as master | `http://agentic-net-master:8082` | None (internal) |
| **Gateway** | Remote / different network | `http://<gateway-host>:8083` | JWT (auto-acquired) |

Configure via environment variables on the executor:

```bash
# Direct mode (default in docker-compose.yml)
MASTER_HOST=agentic-net-master
MASTER_PORT=8082

# Gateway mode (remote deployment)
AGENTICOS_GATEWAY_URL=https://your-gateway-host:8083
AGENTICOS_GATEWAY_SECRET_FILE=/app/gateway-data/jwt/admin-secret
```

### Open-Source Services (this repo)

| Service | Purpose | Port |
|---------|---------|------|
| **agentic-net-gateway** | OAuth2 API gateway with JWT auth | 8083 |
| **agentic-net-executor** | Distributed command execution (polls master directly or via gateway) | 8084 |
| **agentic-net-cli** | Command-line interface with multi-provider LLM | - |
| **agentic-net-chat** | Telegram bot integration | - |
| **sa-blobstore** | Distributed blob storage | 8090 |

### Closed-Source Services (Docker Hub)

| Image | Purpose | Port |
|-------|---------|------|
| `alexejsailer/agenticos-node` | Core data engine with event sourcing | 8080 |
| `alexejsailer/agenticos-master` | Orchestration, LLM integration, transition engine | 8082 |
| `alexejsailer/agenticos-gui` | Angular visual editor | 4200 |

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

Closed-source services from Docker Hub, open-source services built from source.

```bash
cd deployment
cp .env.template .env
# Edit .env with your settings
docker compose up -d
```

### Access Points

| Service | URL |
|---------|-----|
| GUI | http://localhost:4200 |
| Gateway API | http://localhost:8083 |
| Grafana | http://localhost:3000 (admin/admin) |
| Prometheus | http://localhost:9090 |

---

## Repository Structure

```
agentic-nets/
├── LICENSE.md                    # BSL 1.1 (open-source code)
├── PROPRIETARY-EULA.md           # EULA for Docker Hub images
├── README.md
│
├── agentic-net-gateway/             # OAuth2 API gateway (Spring Boot)
├── agentic-net-executor/            # Command executor (Spring Boot)
├── agentic-net-cli/                 # CLI tool (TypeScript/Node.js)
├── agentic-net-chat/                # Telegram bot (TypeScript/Node.js)
├── sa-blobstore/                 # Blob storage (Spring Boot)
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

### LLM Provider

```bash
# Local Ollama (default)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=llama3.2

# Anthropic Claude API
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

### Telegram Bot (Optional)

```bash
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_BOT_USERNAME=your-bot-name
```

---

## Building Open-Source Images

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

All services export metrics and traces via OpenTelemetry.

---

## Licensing

This repository uses a **dual-license model**:

### Open-Source Code (BSL 1.1)

All source code in this repository is licensed under the [Business Source License 1.1](LICENSE.md):

- **Free for**: development, testing, personal, educational, and evaluation use
- **Commercial production use**: requires a commercial license
- **Change Date**: 2030-02-22 (converts to Apache 2.0)

### Proprietary Docker Images (EULA)

The closed-source Docker Hub images (`agenticos-node`, `agenticos-master`, `agenticos-gui`) are governed by the [Proprietary EULA](PROPRIETARY-EULA.md):

- **Free for**: personal, educational, evaluation, non-commercial use
- **Commercial use**: contact alexej@sailer.dev

### No Warranty

**ALL SOFTWARE IN THIS PROJECT IS PROVIDED AS-IS WITH ABSOLUTELY NO WARRANTY.**
This applies to both open-source code and proprietary Docker images.
See the respective license files for full legal terms.

---

## Contact

- **Commercial licensing**: alexejsailer@gmail.com
- **Website**: https://alexejsailer.com
- **Issues**: https://github.com/alexejsailer/agentic-nets/issues

---

Copyright (c) 2025-2026 Alexej Sailer. All rights reserved.
