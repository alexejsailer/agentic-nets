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
- Apple Silicon Macs can run the current Docker Hub images through Docker Desktop's `linux/amd64` emulation. Docker may print platform-mismatch warnings on first start; they are expected unless multi-arch images have been published for your release.
- One LLM backend:
  - Anthropic Claude API key, or
  - OpenAI API key, or
  - bundled Ollama. The default cloud model requires `ollama signin`; a fully local model requires setting a local tag such as `llama3.2` and pulling it into the container.
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

### First-Run Knowledge Seed

On startup, `agentic-net-master` seeds system knowledge into `sa-blobstore` under stable `knowledge-seed/...` blob IDs. This includes transition-language docs, ArcQL/parser source, inscription validators, designtime/runtime source, and real JSON inscription examples.

The seed does not create tokens in your user models. Clean models stay empty; `SEARCH_KNOWLEDGE` searches the system seed catalog and returns blob URNs, then `READ_BLOB_TEXT` reads the matching blob content.

### Docker Tool Registry Seed

Agentic-Nets includes a local OCI registry on `localhost:5001`. Agents do not run arbitrary public images; master is allowlisted to run curated local images matching `localhost:5001/agenticos-*`.

To populate that registry with the approved Docker tool images for your `AGENTICNETOS_VERSION`, run the one-shot seeder after the stack is up:

```bash
docker compose -f docker-compose.hub-only.yml --profile tools run --rm agenticos-tool-seeder
curl http://localhost:5001/v2/_catalog
```

For the no-monitoring stack, use the same command with `docker-compose.hub-only.no-monitoring.yml`.

The seeded tools are:

| Tool image | Primary endpoint | Use |
|---|---|---|
| `agenticos-tool-echo` | `POST /*` | Smoke tests and request debugging |
| `agenticos-tool-crawler` | `POST /crawl` | Crawl web pages and extract structured content |
| `agenticos-tool-rss` | `POST /fetch` | Fetch and parse RSS/Atom feeds |
| `agenticos-tool-search` | `POST /search` | Web search via DuckDuckGo HTML |
| `agenticos-tool-reddit` | `POST /posts`, `/search`, `/comments` | Reddit data discovery |
| `agenticos-tool-secured-api` | `POST /data` | API-key-protected test endpoint |

Agents discover and use these with `REGISTRY_LIST_IMAGES`, `REGISTRY_GET_IMAGE_INFO`, `DOCKER_RUN`, an HTTP transition pointed at the returned `baseUrl`, and `DOCKER_STOP` when the tool is no longer needed. Tool containers are attached to the Agentic-Nets backend network and are auto-cleaned by TTL unless started as persistent.

For tool development instead of Docker Hub mirroring:

```bash
AGENTICOS_TOOL_SEED_MODE=build \
docker compose -f docker-compose.yml --profile tools run --rm agenticos-tool-seeder
```

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

An Ollama container (`agenticnetos-ollama`) ships inside the compose stack — you do **not** need to install Ollama on your host.

The default `.env.template` model is `deepseek-v3.1:671b-cloud`, a cloud-suffixed Ollama model routed through `ollama.com`. After `docker compose up -d`, authenticate the bundled Ollama container once:

```bash
docker exec -it agenticnetos-ollama ollama signin
```

The command prints a `https://ollama.com/connect?...` URL. Copy it into a browser, sign in to your ollama.com account (free), and click **Connect**. The CLI will confirm `Signed in as ...` and exit. The ed25519 keypair is persisted in the `ollama-data` volume — no need to repeat this unless you wipe the volume or delete the key at https://ollama.com/settings/keys.

If you run the command over SSH, use `ssh -t` so docker exec gets an interactive TTY:

```bash
ssh -t user@your-host 'docker exec -it agenticnetos-ollama ollama signin'
```

If `/connect` gives **"Invalid key format"**, fall back to the manual route: run `docker exec agenticnetos-ollama cat /root/.ollama/id_ed25519.pub`, then paste that line at https://ollama.com/settings/keys → **Add public key**.

For a fully local model instead, edit `.env` first and set all four Ollama model variables to a local tag such as `llama3.2`:

```bash
OLLAMA_MODEL=llama3.2
OLLAMA_HIGH_MODEL=llama3.2
OLLAMA_MEDIUM_MODEL=llama3.2
OLLAMA_LOW_MODEL=llama3.2
```

Then pull that model into the running container:

```bash
docker exec agenticnetos-ollama ollama pull llama3.2
```

**Using host Ollama instead** (useful for GPU access): install Ollama on your host, run `ollama pull llama3.2`, and override `OLLAMA_BASE_URL` in `.env`:

- Docker Desktop (Mac/Windows): `OLLAMA_BASE_URL=http://host.docker.internal:11434`
- Linux-native Docker: `OLLAMA_BASE_URL=http://172.17.0.1:11434`

**Cloud-suffixed models** (e.g. `kimi-k2.5:cloud`, `gpt-oss:120b-cloud`) route through `ollama.com` and require `ollama signin` — see `POST_DEPLOYMENT_CONFIG.md`.

### OpenAI

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

## Environment Reference

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `AGENTICNETOS_VERSION` | Yes | `2.1.10` | Docker image tag for all Agentic-Nets services. |
| `TEMPO_IMAGE`, `OTEL_COLLECTOR_IMAGE`, `PROMETHEUS_IMAGE`, `GRAFANA_IMAGE`, `OLLAMA_IMAGE` | No | pinned in `.env.template` | Third-party image pins for reproducible installs. |
| `AGENTICNETOS_BIND_ADDRESS` | Yes | `127.0.0.1` | Host interface for published ports. Use `0.0.0.0` only intentionally. |
| `LLM_PROVIDER` | Yes | `ollama` | Active LLM backend: `ollama`, `claude`, `openai`, `claude-code`, `codex`. |
| `AGENTICOS_MODEL_TIER` | No | `medium` | Tier used by CLI/chat model routing. |
| `ANTHROPIC_API_KEY` | Claude only | empty | Anthropic API key. |
| `OPENAI_API_KEY` | OpenAI only | empty | OpenAI API key. |
| `OLLAMA_BASE_URL` | Ollama only | `http://ollama:11434` | Ollama endpoint reachable from containers. Points at the bundled `agenticnetos-ollama` service. Override for host-Ollama (Docker Desktop: `http://host.docker.internal:11434`; Linux: `http://172.17.0.1:11434`). |
| `OLLAMA_MODEL` | Ollama only | `deepseek-v3.1:671b-cloud` | Single model used by master. Requires `ollama signin`; change to a pulled local tag for offline use. |
| `OLLAMA_HIGH_MODEL`, `OLLAMA_MEDIUM_MODEL`, `OLLAMA_LOW_MODEL` | Ollama only | `deepseek-v3.1:671b-cloud` | Tiered model routing for CLI/chat. Requires `ollama signin`; change to pulled local tags for offline use. |
| `AGENTICOS_ADMIN_SECRET` | Shared envs | generated | Gateway admin client secret. Empty means auto-generate under `data/gateway/jwt/admin-secret`. |
| `AGENTICOS_SETTINGS_KEY` | Shared envs | empty | Stable encryption key for persisted settings/credentials. |
| `OPENBAO_DEV_ROOT_TOKEN` | Yes | `agenticos-dev-token` | OpenBao dev token used by the local vault stack. Change before sharing. |
| `GRAFANA_ADMIN_PASSWORD` | Monitoring only | `admin` | Grafana admin password. |
| `GATEWAY_INTERNAL_SECRET` | Yes | local placeholder | Shared secret for Gateway <-> Master internal registry calls. Change before sharing. |
| `GATEWAY_CORS_ALLOWED_ORIGIN_PATTERNS`, `AGENTICOS_CORS_ALLOWED_ORIGIN_PATTERNS` | No | localhost only | Browser origins allowed to call Gateway, Master, and Node APIs. |
| `GATEWAY_TIMEOUT` | No | `30` | Gateway upstream timeout in seconds. |
| `GATEWAY_PROXY_TIMEOUT` | No | `300` | Gateway proxy timeout for long agent/LLM calls. |
| `AGENTICOS_REGISTRY_ENABLED` | No | `true` | Enables local OCI tool registry integration. |
| `AGENTICOS_DOCKER_ENABLED` | No | `true` | Allows master to start Docker tool containers. |
| `AGENTICOS_DOCKER_IMAGE_ALLOWLIST` | No | `localhost:5001/agenticos-*` | Restricts which tool images agents may start through the Docker socket. |
| `AGENTICOS_TOOL_REGISTRY_HOST` | No | `localhost:5001` | Local registry host used by the tool seeder and Docker daemon. If you change `AGENTICNETOS_REGISTRY_PORT`, update this and the allowlist too. |
| `AGENTICOS_TOOL_SOURCE_REGISTRY` | No | `docker.io/alexejsailer` | Docker Hub namespace used when mirroring approved tool images. |
| `AGENTICOS_TOOL_SEED_TAG` | No | empty | Tool image tag to seed. Empty means use `AGENTICNETOS_VERSION`. |
| `AGENTICOS_TOOL_SEED_MODE` | No | `mirror` | `mirror` pulls published tool images; `build` builds from `agentic-net-tools/`. |
| `AGENTICOS_TOOL_SEED_IMAGES` | No | approved built-ins | Space-separated list of tool images to seed. |
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
| `AGENTICNETOS_REGISTRY_PORT` | `5001` | local OCI registry. Change to a free port, for example `5002`, if another registry already owns `5001`. |
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

If startup fails with `Bind for 0.0.0.0:5001 failed: port is already allocated`, edit `.env` and set:

```env
AGENTICNETOS_REGISTRY_PORT=5002
```

Then rerun the same `docker compose ... up -d` command. The registry is only bound to localhost by default, so any free local port is fine.

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

## Release Notes

Image releases are tagged on GitHub and published to Docker Hub under `alexejsailer/agenticnetos-*`. The `AGENTICNETOS_VERSION` variable controls which tag is used by the compose files. Pin a specific version in `.env` when you need reproducible deployments.
