# Agentic-Nets Docker Compose Deployment

This directory is the public, self-contained local deployment entry point. A newcomer should be able to clone the repo, copy `.env.template` to `.env`, choose an LLM provider, and start the complete Agentic-Nets stack with one Docker Compose command.

## Compose Files

| File | What it runs | Best for |
|---|---|---|
| `docker-compose.hub-only.yml` | Complete stack from Docker Hub, including Grafana, Prometheus, Tempo, and OTel Collector | First run with observability |
| `docker-compose.hub-only.no-monitoring.yml` | Complete runtime stack from Docker Hub, without Grafana/Prometheus/Tempo/OTel | Lighter local evaluation |
| `docker-compose.yml` | Hybrid stack: closed-source core images from Docker Hub, open-source services built locally | Contributors working on this repo |

Closed-source images (`agenticnetos-node`, `agenticnetos-master`, `agenticnetos-gui`) are pulled from Docker Hub and governed by `../PROPRIETARY-EULA.md`. Open-source services in this repo are governed by `../LICENSE.md`.

## Prerequisites

- Docker Desktop or Docker Engine with Compose v2.
- At least 8 GB free RAM for the full stack; 4 GB is usually enough for the no-monitoring stack.
- One LLM backend:
  - Anthropic Claude API key, or
  - local Ollama with a pulled model such as `llama3.2`.
- `bash` and `curl` for health checks and troubleshooting.

## First Run

```bash
cd agentic-nets/deployment
cp .env.template .env
```

Edit `.env`, then pick one of the two runtime profiles.

### Option A: Full Stack With Monitoring

```bash
docker compose -f docker-compose.hub-only.yml up -d
```

Open:

- Studio: http://localhost:4200
- Gateway health: http://localhost:8083/api/health/ping
- Grafana: http://localhost:3000
- Prometheus: http://localhost:9090
- Tempo: http://localhost:3200

### Option B: Runtime Stack Without Monitoring

```bash
docker compose -f docker-compose.hub-only.no-monitoring.yml up -d
```

Open:

- Studio: http://localhost:4200
- Gateway health: http://localhost:8083/api/health/ping

### Option C: Hybrid Source Build

Use this when you are developing the open-source services in this repo. It pulls closed-source core images from Docker Hub and builds gateway, executor, vault, CLI, chat, and blobstore locally.

```bash
docker compose up -d
```

## LLM Setup

### Claude

```env
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

This is the fastest path for the Universal Assistant and Builder personas.

### Ollama

An Ollama container (`agenticnetos-ollama`) ships inside the compose stack — you do **not** need to install Ollama on your host. After `docker compose up -d`, pull the model into the running container:

```bash
docker exec agenticnetos-ollama ollama pull llama3.2
```

The defaults in `.env.template` already target the bundled container:

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2
OLLAMA_HIGH_MODEL=llama3.2
OLLAMA_MEDIUM_MODEL=llama3.2
OLLAMA_LOW_MODEL=llama3.2
```

**Using host Ollama instead** (useful for GPU access): install Ollama on your host, run `ollama pull llama3.2`, and override `OLLAMA_BASE_URL` in `.env`:

- Docker Desktop (Mac/Windows): `OLLAMA_BASE_URL=http://host.docker.internal:11434`
- Linux-native Docker: `OLLAMA_BASE_URL=http://172.17.0.1:11434`

**Cloud-suffixed models** (e.g. `kimi-k2.5:cloud`, `gpt-oss:120b-cloud`) route through `ollama.com` and require `ollama login` — see `POST_DEPLOYMENT_CONFIG.md`.

### OpenAI

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

## Environment Reference

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `AGENTICNETOS_VERSION` | Yes | `2.1.2` | Docker image tag for all services. CI updates this during release. |
| `AGENTICNETOS_BIND_ADDRESS` | Yes | `127.0.0.1` | Host interface for published ports. Use `0.0.0.0` only intentionally. |
| `LLM_PROVIDER` | Yes | `ollama` | Active LLM backend: `ollama`, `claude`, `openai`, `claude-code`, `codex`. |
| `AGENTICOS_MODEL_TIER` | No | `medium` | Tier used by CLI/chat model routing. |
| `ANTHROPIC_API_KEY` | Claude only | empty | Anthropic API key. |
| `OPENAI_API_KEY` | OpenAI only | empty | OpenAI API key. |
| `OLLAMA_BASE_URL` | Ollama only | `http://ollama:11434` | Ollama endpoint reachable from containers. Points at the bundled `agenticnetos-ollama` service. Override for host-Ollama (Docker Desktop: `http://host.docker.internal:11434`; Linux: `http://172.17.0.1:11434`). |
| `OLLAMA_MODEL` | Ollama only | `llama3.2` | Single model used by master. |
| `OLLAMA_HIGH_MODEL`, `OLLAMA_MEDIUM_MODEL`, `OLLAMA_LOW_MODEL` | Ollama only | `llama3.2` | Tiered model routing for CLI/chat. |
| `AGENTICOS_ADMIN_SECRET` | Shared envs | generated | Gateway admin client secret. Empty means auto-generate under `data/gateway/jwt/admin-secret`. |
| `AGENTICOS_SETTINGS_KEY` | Shared envs | empty | Stable encryption key for persisted settings/credentials. |
| `OPENBAO_DEV_ROOT_TOKEN` | Yes | `agenticos-dev-token` | OpenBao dev token used by the local vault stack. Change before sharing. |
| `GRAFANA_ADMIN_PASSWORD` | Monitoring only | `admin` | Grafana admin password. |
| `GATEWAY_TIMEOUT` | No | `30` | Gateway upstream timeout in seconds. |
| `GATEWAY_PROXY_TIMEOUT` | No | `300` | Gateway proxy timeout for long agent/LLM calls. |
| `AGENTICOS_REGISTRY_ENABLED` | No | `true` | Enables local OCI tool registry integration. |
| `AGENTICOS_DOCKER_ENABLED` | No | `true` | Allows master to start Docker tool containers. |
| `TELEGRAM_BOT_ENABLED` | No | `false` | Enables the Telegram bridge container. |
| `TELEGRAM_BOT_TOKEN` | Telegram only | empty | Bot token from BotFather. |
| `TELEGRAM_BOT_ALLOWED_CHAT_IDS` | Telegram only | empty | Comma-separated allowlist for chat access. |
| `AGENTICNETOS_NODE_DATA_DIR` | No | `~/.agenticos` | Host directory for Node events and snapshots. |

### Published Ports

All ports bind to `AGENTICNETOS_BIND_ADDRESS`.

| Variable | Default | Service |
|---|---:|---|
| `AGENTIC_NET_NODE_PORT` | `8080` | agentic-net-node |
| `AGENTIC_NET_MASTER_PORT` | `8082` | agentic-net-master |
| `AGENTIC_NET_GATEWAY_PORT` | `8083` | agentic-net-gateway |
| `AGENTIC_NET_EXECUTOR_PORT` | `8084` | agentic-net-executor |
| `AGENTIC_NET_VAULT_PORT` | `8085` | agentic-net-vault |
| `AGENTIC_NET_GUI_PORT` | `4200` | agentic-net-gui |
| `SA_BLOBSTORE_PORT` | `8090` | sa-blobstore |
| `AGENTICNETOS_REGISTRY_PORT` | `5001` | local OCI registry |
| `GRAFANA_PORT` | `3000` | Grafana |
| `PROMETHEUS_PORT` | `9090` | Prometheus |
| `TEMPO_PORT` | `3200` | Tempo |
| `OTEL_COLLECTOR_GRPC_PORT` | `4317` | OTel Collector gRPC |
| `OTEL_COLLECTOR_HTTP_PORT` | `4318` | OTel Collector HTTP |

## Verify

```bash
docker compose -f docker-compose.hub-only.yml ps

curl http://localhost:8083/api/health/ping
curl http://localhost:8082/actuator/health
curl http://localhost:8080/actuator/health
```

For the no-monitoring stack, use `-f docker-compose.hub-only.no-monitoring.yml`.

If a service restarts, inspect logs:

```bash
docker compose -f docker-compose.hub-only.yml logs agentic-net-master --tail=80
```

## Build Your First Net

After the stack is healthy, open the Studio:

```bash
open http://localhost:4200
```

Create or select a concrete model and session, then create a workspace net. On an
empty canvas, click **Ask the Universal Assistant**, or right-click the canvas and
choose **Open Universal Assistant**. Start with:

```text
Help me build my first net.
```

Universal Assistant explains and routes work. For changes to the net, switch to
or invoke the **Workflow Builder** persona, which can create places, transitions,
arcs, inscriptions, and deploy the result in the active model/session.

After Builder changes structure, use the editor header sync buttons:

- **net sync** saves structural edits and reloads remote changes.
- **token sync** refreshes live token counts from the backend.

## Stop and Reset

Stop while preserving data:

```bash
docker compose -f docker-compose.hub-only.yml down
```

Delete containers and named volumes:

```bash
docker compose -f docker-compose.hub-only.yml down -v
```

Node event/snapshot data lives in `AGENTICNETOS_NODE_DATA_DIR` and is not removed by `down -v`.

## Release Notes for Maintainers

`ci/VERSION` is the source of truth. The `agenticos-prepare-release` Jenkins job updates `AGENTICNETOS_VERSION` in `.env.template` and pins defaults in all public compose files, then builds, stages, health-checks, and creates local git tags. `agenticos-promote-hub` pushes the staged images to Docker Hub and runs `deployment/scripts/update-versions.sh` so the GitHub deployment files point at the promoted release.

Do not push from automation. Push tags and branches manually after staging validation.
