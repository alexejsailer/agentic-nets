# Changelog

All notable changes to the AgenticNets open-source services are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.8] - 2026-04-22

### Fixed
- **Master `GET /api/admin/models/{modelId}/status` 404.** Master's
  `ModelController` proxied every other admin-model lifecycle endpoint
  (`POST /load`, `POST /activate`, `POST /deactivate`, `POST /unload`,
  `DELETE`) to node, but the `status` endpoint was missing — node has it
  at `/admin/models/{modelId}/status`, gateway routes `/api/*` to master,
  so the call returned 404. The GUI polls this endpoint while the Studio
  is open; the repeated 404s made lifecycle state (active/inactive,
  current version, element count) look stale even though the backend was
  processing requests, and in the Universal Assistant it left the model
  indicator spinning while the agent loop was actually running. Added
  the proxy method in master's `ModelController` so GET /status now
  forwards to node and returns the lifecycle snapshot.

## [2.1.7] - 2026-04-22

### Fixed
- **GUI default service URLs for reverse-proxy deployments.** When the Studio
  is served behind a public hostname (Apache/Nginx/Cloudflare in front of
  the compose stack), the GUI was defaulting every service base URL to
  `<scheme>://<public-host>:<port>` — e.g. `https://gui.example.com:8083`.
  Browsers then tried to open port 8083 on the public host, which is bound
  to `127.0.0.1` on the server and unreachable from the internet; every
  post-login XHR failed with `ERR_CONNECTION_REFUSED` and the Universal
  Assistant chat silently never reached master. Fixed
  `resolveDefaultServiceUrl()` in `core/agentic-net-gui/.../service-url.util.ts`
  to return the browser's origin **without a port** when
  `isBehindReverseProxy()` is true, so `/api/*` and `/node-api/*` become
  relative-to-origin and route through the reverse proxy. Also patched
  `normalizeServiceBaseUrl()` so stored localhost-era URLs get
  auto-migrated on load — existing users don't need to clear localStorage.
  Pure-local evaluation (`http://localhost:<non-4200-port>`) keeps the
  classic `http://localhost:<port>` form. No `.env` change required — the
  GUI auto-detects the right pattern at runtime from the browser origin.

## [2.1.6] - 2026-04-22

### Docs
- **CORS for public deployments — explicit warning + example.** The default
  `GATEWAY_CORS_ALLOWED_ORIGIN_PATTERNS` and
  `AGENTICOS_CORS_ALLOWED_ORIGIN_PATTERNS` in `.env.template` only allow
  `http://localhost:*` / `http://127.0.0.1:*`. Operators putting the GUI
  behind a real public hostname (Apache/Nginx/Cloudflare reverse proxy)
  hit `HTTP 403 "Invalid CORS request"` from the gateway and master on
  every XHR — the login button silently fails. Both env vars now have a
  prominent ⚠️ comment block in `.env.template` with a runnable example
  (`https://gui.example.com`), and `deployment/PUBLIC-TLS-DEPLOYMENT.md`
  has a new **Phase 4.5 — Allow your public origin in CORS** section
  with edit-and-recreate instructions plus a curl-with-Origin probe to
  verify the fix. Troubleshooting list also gained an explicit entry for
  "Login button does nothing / 403 Invalid CORS request in DevTools".

## [2.1.5] - 2026-04-22

### Fixed
- **Executor missing `AGENTICOS_CREDENTIALS_KEY` env bridge.** Master was
  receiving the key, but executor wasn't — so encrypted transition credentials
  couldn't be decrypted on the executor side. Added
  `AGENTICOS_CREDENTIALS_KEY: ${AGENTICOS_SETTINGS_KEY:-}` to the executor
  service env block in all three compose files
  (`docker-compose.yml`, `docker-compose.hub-only.yml`,
  `docker-compose.hub-only.no-monitoring.yml`).
- **Tempo healthcheck** was probing `wget http://localhost:3200/ready` but the
  `grafana/tempo:2.10.4` image is distroless (no `wget`/`curl`/`sh`) — so every
  probe failed even though Tempo was serving. Disabled the healthcheck,
  matching the pattern already used for `otel-collector`. Container exit code
  is authoritative; compose restarts on crash.
- **Prometheus blobstore scrape target** was still pointing at
  `sa-blobstore:8080` (API port) from before the 2.1.3 actuator-port move.
  Updated `monitoring/config/prometheus.yaml` to scrape `sa-blobstore:9090`
  (Spring Boot management port). The 6th Prometheus target now reports `up`.
- **Typo `AgetnticOS`** in `monitoring/config/prometheus.yaml` comment header
  → `AgenticNetOS`.

## [2.1.4] - 2026-04-21

### Security
- **Gateway `GET /internal/masters` now requires the shared internal secret.**
  The register/heartbeat/deregister endpoints already enforced
  `X-Agenticos-Internal-Secret` (constant-time compare), but the listing
  endpoint let any caller enumerate registered master URLs. Same check now
  applies to all four verbs.
- **`GATEWAY_INTERNAL_SECRET` default** in `.env.template` strengthened with an
  explicit "public on GitHub" warning plus `openssl rand -hex 32` command for
  generating a replacement before exposing the stack beyond 127.0.0.1.
- **Executor service metadata** typo `AgetnticOS` → `AgenticNetOS` in
  `/actuator/info` output.

### Fixed
- **OpenTelemetry Collector image pin** `0.150.0` → `0.135.0`. The 0.150.0 tag
  did not exist on Docker Hub (speculative pin), causing
  `docker compose up` to fail with "not found" during the user-sim. 0.135.0 is
  a verified stable release and is present on Hub.
- **`user-sim.sh` model alignment.** The .env.template default
  (`deepseek-v3.1:671b-cloud`) requires `ollama login` and thus can't run
  unattended. The sim now sed-overrides `OLLAMA_MODEL` (and HIGH/MEDIUM/LOW
  tiers) to match the `--model` flag (default `llama3.2`) so the sim uses the
  same model it actually pulls.
- **`user-sim.sh` gateway internal secret.** Sim now generates a random
  `GATEWAY_INTERNAL_SECRET` alongside the admin secret and settings key, so
  the deployed gateway doesn't inherit the public-default placeholder.

### Docs
- README top now leads with a license/usage table (open-source vs closed-source,
  who can use each).
- README Install step rewritten around the new cloud-default model + `ollama
  login` flow, with a sidebar explaining where the Ollama token comes from.
- Added "Welcome to Agentic-Nets" section with the nine production gaps.
- Architecture diagram rebuilt to show the Gateway as the JWT entry point for
  all client agents (gui, cli, chat, executor) with vault + sa-blobstore as
  backend data-tier services.
- CONTRIBUTING updated to cover `agentic-net-tools/` builds and the
  no-monitoring compose variant.
- Added `.claude/agents/agenticos-net-builder.md` — a Claude-Code-compatible
  agent doc (credential-safe, public-repo adjusted) for users who want an
  expert assistant when building nets.
- Added YouTube walkthrough playlist link to README Contact section.
- Added "Encryption key for transition credentials" section to
  `agentic-net-executor/README.md` documenting the
  `AGENTICOS_SETTINGS_KEY` (user-facing) → `AGENTICOS_CREDENTIALS_KEY`
  (service-side) env-var bridge.

## [2.1.3] - 2026-04-21

### Fixed — first-time-user experience on Linux (surfaced in 2.1.2 install-sim)
- **Bind-mount permissions**. On Linux hosts Docker auto-created bind-mount
  directories (`./data/logs/*`, `${AGENTICNETOS_NODE_DATA_DIR:-~/.agenticos}`)
  as `root:root`, then Java services running as non-root UIDs hit
  `java.io.FileNotFoundException: Permission denied` and
  `java.nio.file.AccessDeniedException` on their first boot. All three compose
  files now include a one-shot `init-perms` service (alpine:3.20) that
  `mkdir -p` every bind-mount subdirectory and `chmod -R 777` them before any
  Java service starts; every service declares
  `depends_on: init-perms: condition: service_completed_successfully`. No-op
  on Docker Desktop.
- **Blobstore healthcheck**. Was targeting `:8080/actuator/health` (the API
  port) where no actuator endpoint exists; container stayed permanently
  marked unhealthy while actually working fine. Fixed to target
  `:9090/actuator/health` (Spring Boot management port).
- **otel-collector healthcheck**. The upstream image is distroless and has no
  `wget`, `curl`, or `sh`; every healthcheck invocation failed with `OCI
  runtime exec failed: executable file not found in $PATH`. Disabled the
  healthcheck — the collector's process exit code is authoritative.
- **Ollama memory default** raised from `4G` to `8G`. On Linux cgroups the
  `4G` limit left Ollama reporting `free=2.0 GiB`, which failed the
  `llama3.2` load check (`model requires more system memory (2.3 GiB) than is
  available (2.0 GiB)`). At `8G` `llama3.2` loads and serves.

### Changed
- **Chat service gated behind the `telegram` compose profile**. With
  `TELEGRAM_BOT_ENABLED=false` (the default) the chat container used to log
  "No Telegram bot token configured" and restart-loop forever, wasting
  resources and polluting `docker ps`. It now only starts when users opt in
  via `docker compose --profile telegram up -d`.

## [2.1.2] - 2026-04-21

### Added
- **Bundled Ollama container** in all three public compose files
  (`docker-compose.yml`, `docker-compose.hub-only.yml`,
  `docker-compose.hub-only.no-monitoring.yml`). First-time users no longer
  need to install Ollama on the host — `docker compose up -d` now starts an
  `agenticnetos-ollama` service out of the box. Pull your model with
  `docker exec agenticnetos-ollama ollama pull llama3.2` after the stack is up.
- `OLLAMA_MEMORY_LIMIT` and `OLLAMA_CPU_LIMIT` env vars so users can size the
  bundled Ollama container for larger models.

### Changed
- Default `AGENTICNETOS_VERSION` in all compose files bumped from `2.0.0` to
  `2.1.2` so `docker compose up -d` pulls the current release without manual
  `.env` edits.
- Default `OLLAMA_BASE_URL` changed from `http://host.docker.internal:11434`
  to `http://ollama:11434` (the bundled service). Host-Ollama remains a
  supported override; `deployment/README.md` and `POST_DEPLOYMENT_CONFIG.md`
  document both paths including the Linux `172.17.0.1` alternative.
- `agentic-net-master` now `depends_on: ollama` (with `service_healthy`
  condition) so it does not start before the LLM runtime is up.

### Docs
- README quickstart updated with the new `docker exec agenticnetos-ollama
  ollama pull` step and reordered to reflect the bundled-container default.
- `deployment/README.md` Ollama section rewritten: bundled-container default
  first, host-Ollama as an opt-in for GPU users.
- `deployment/POST_DEPLOYMENT_CONFIG.md` Ollama section updated to match.
- Environment reference table now shows `AGENTICNETOS_VERSION=2.1.2` and
  `OLLAMA_BASE_URL=http://ollama:11434` defaults.

### Added — multi-agent coordination

- **Two-tier LLM config per agent transition.** Every agent inscription can
  declare `toolsModel` + `thinkingModel` + `activeTier` pointer. A single
  fire runs entirely on the resolved model; flipping `activeTier` via
  `SET_INSCRIPTION` takes effect on the next fire. Works for both `api`
  mode (master's global LlmService) and `bash` mode (`claude -p` or
  `codex exec`). Back-compat with legacy `action.model` / `action.llmCommand`
  preserved.
- **Tool sessions & tool-net marketplace.** Sessions can be tagged (e.g.
  `tools`). Tool nets carry a manifest leaf describing their trigger place,
  result place, and correlation field. Seven new agent tools: `TAG_SESSION`,
  `LIST_SESSIONS_BY_TAG`, `LIST_TOOL_NETS`, `DESCRIBE_TOOL_NET`,
  `REGISTER_TOOL_NET`, `INVOKE_TOOL_NET` (synchronous, correlation-id
  matched), `SCAFFOLD_TOOL_NET` (auto-build a new tool skeleton).
- **Hierarchical overview agent tools.** `GET_SESSION_OVERVIEW`,
  `GET_NET_OVERVIEW`, `FIND_NET_NEIGHBORS` — one-shot summaries replacing
  the previous `LIST_SESSION_NETS` + per-net `GET_NET_STRUCTURE` + manual
  assembly chain.
- **Agent tool catalog.** `agent-tool-catalog.json` is the single source of
  truth for tool definitions; `GET /api/agent/tools/catalog` exposes it;
  the CLI regenerates `tools.generated.ts` via `npm run sync-tools` so the
  CLI agent surface stays in sync with the master.
- **Workspace graph editor** (GUI). New meta-editor tab showing nets as
  nodes and shared places / link transitions as edges. ELK auto-layout,
  persisted per-user positions, GPU-accelerated pan/zoom, dark/light theme,
  minimizable floating toolbar, double-tap fit-to-view, Escape to return
  to page scroll.
- **Telegram-agent streaming.** The chat agent now streams tool-call
  batches live to Telegram (batched every 3 calls). New `/verbose` command
  toggles streaming per chat. Tool names render bold, params in
  monospace, sub-agent calls get a distinct `↳ (sub-agent)` prefix.
- **Package session bundles + cross-gateway transfer.** Package registry
  can now bundle whole sessions and transfer them across gateways with a
  single CLI command.
- **Readonly client credential.** Gateway supports a read-only JWT scope
  enforced by a filter; safe to hand out for view-only integrations.
- **`INSPECT_TOKEN_SIZE` tool** + auto-truncation + auto content mode to
  keep agent context windows predictable on large tokens.
- **Persona awareness of the new feature set.** Builder / operator /
  coordinator / chronicle persona docs all updated to reference two-tier
  LLM config, tool-nets, and overview tools.

### Fixed

- **`ClaudeCodeProvider` for claude CLI v2.1+.** The old `--tools ''`
  deprecation flag no longer disables built-in tools; switched to
  `--disallowedTools '...'` + `--strict-mcp-config`. XML tool-call
  protocol preamble moved to the top of the system prompt.
- **Pre-existing test files** updated for `SessionTagService` +
  `ToolNetService` constructor-parameter additions.

### Docs

- New `ARCHITECTURE.md`: transition types, ArcQL basics, pull-polling
  executor model, multi-agent coordination via shared places, tool-net
  marketplace.
- New `docs/two-tier-llm-config.md`: canonical reference for per-agent
  model tiers (also embedded into `agent-knowledge-core.md`,
  `agent-knowledge-write.md`, `agent-knowledge-autonomous.md`, and the CLI
  `WRITE_KNOWLEDGE` prompt).
- New `docs/agent-knowledge-tool-nets.md`: charter for tool sessions.
- Per-service READMEs for gateway / vault / cli / chat / blobstore.
- GitHub issue templates: bug + feature.

## [1.19.0] - 2026-03-23

### Added
- **Persona framework**: Pluggable assistant personas (builder, observer, analyzer, debugger) with role-based tool filtering
- **OBSERVE_MODEL tool**: Whole-model runtime snapshots for monitoring and debugging
- **GUI persona selector**: Dropdown in universal assistant editor to switch between personas
- **Version-pinned compose files**: All image tags use `AGENTICNETOS_VERSION` env var (no more `latest` drift)
- **Automated version pinning**: Release pipeline now updates compose file versions
- **CHANGELOG.md**: This file

### Changed
- Compose files now use `${AGENTICNETOS_VERSION:-1.19.0}` instead of hardcoded `1.2.0` or `latest`
- `.env.template` includes `AGENTICNETOS_VERSION` variable

## [1.18.0] - 2026-03-20

### Added
- Dev task nets
- 5 new CLI tools (DELETE_PLACE, DELETE_ARC, param aliases, path auto-correction)

## [1.15.0] - 2026-03-10

### Changed
- MasterPollingIntegrationTest updated for configuredModels parameter

## [1.11.0] – [1.14.0]

Rolling improvements across master, executor, and gateway stabilization; detailed history captured in git log.

## [1.9.0] - 2026-02-20

### Added
- Dry-run transition support
- Periodic scheduler for transitions
- Improved agent prompts with deterministic-first guidance

## [1.6.0] - 2026-02-10

### Fixed
- Bootstrap transitions node on fresh deploy for SET_INSCRIPTION
- Rollup path traversal vulnerability (GHSA-mw96-cpmx-2vgc)
- Graceful error handling for LIST_ALL_INSCRIPTIONS, GET_NET_STRUCTURE, NET_DOCTOR

### Changed
- Default Ollama model switched to kimi-k2.5:cloud
- Increased chat iteration limits for complex workflows
- Added AGENTICOS_PROVIDER env var to chat service
