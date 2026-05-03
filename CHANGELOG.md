# Changelog

All notable changes to the AgenticNets open-source services are documented here.

This file holds only the **current calendar quarter's** releases. Older
quarters are archived under [`changelogs/`](changelogs/) — see
[`changelogs/README.md`](changelogs/README.md) for the index. At the end of
each quarter, the entries below get moved into a new `changelogs/CHANGELOG-YYYY-Qn.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.0] - 2026-05-03

### No code changes — released for parity with sibling repo (see `core/CHANGELOG.md` for the actual changes)
The headline of v2.3.0 lives entirely in `core/`: the full eight-persona `safe-teams` SAFe agile-team model (Product Manager · Architect · Developer · QA · DevOps · Scrum Master · Release Train Engineer · Domain Expert) wired as a single Agentic-Net that turns one chat message into a real git commit, plus the agent loop hardening (null-property handling, fireOnce cancel reset, raised same-tool-call ceiling), the new Domain Expert persona registration, the periodic model backup pipeline (filesystem + sa-blobstore sinks), and node-side hard-delete on `DELETE /api/admin/models/{id}`. None of these touched the open-source services in this repo. The `safe-teams` developer chain does invoke the public `agentic-net-executor` and the model-backup pipeline writes via the public `sa-blobstore` REST API (`POST /api/blobs/...`) — both unchanged in v2.3.0; the existing surfaces were sufficient.

## [2.2.2] - 2026-04-30

> The closed-source images shipped with this release (`agentic-net-node`,
> `agentic-net-master`, `agentic-net-gui` on Docker Hub) carry several
> bug fixes that are user-visible to anyone running the public compose.
> They're listed under "Fixed (closed-source images)" below — the
> source for those services lives in a separate private repo, so the
> notes describe behavior changes rather than file-level diffs.

### Added
- **`FOUNDATIONS.md`** at the repo root — a 13-row 1:1 architectural
  comparison between the author's 2012 KIT/AIFB diploma thesis
  ("Konzeption und Realisierung einer Simulationskomponente zur
  risikobewussten Prozessanalyse") and Agentic-Nets today, covering
  substrate, data model, query language, persistence, schema
  enforcement, firing strategies, risk model, and modelling-tool
  integration. Includes 14 figures from the original thesis under
  `docs/foundations/` organised into five acts (architecture, query
  language, authoring surface, risk extension, case study) with
  fair-use academic-citation attribution to KIT-Horus / AIFB.

### Changed
- **CHANGELOG quarterly rotation applied.** Older `## [X.Y.Z]` entries
  for releases predating the current quarter were moved out of
  `CHANGELOG.md` into `changelogs/CHANGELOG-YYYY-Qn.md` archives. The
  current quarter's entries (and `## [Unreleased]`) remain in
  `CHANGELOG.md` as before. See `changelogs/README.md` for the index;
  the rotation rule itself is documented in `../CLAUDE.md`. No code or
  service behavior is affected.

### Fixed (closed-source images)
- **Universal Assistant respects model switches** (`agentic-net-gui`).
  Selecting an open Universal Assistant tab after switching the active
  canvas to a different model previously kept the assistant bound to
  the model it was first opened against, so every tool call (including
  `LIST_ALL_SESSIONS`, `GET_NET_STRUCTURE`, `OBSERVE_MODEL`) ran against
  the wrong model and returned an unrelated answer. The assistant now
  follows the live workspace context — switch the canvas, send a
  message, and the request goes out with the correct `modelId`.
- **Activate / Deactivate model buttons update the UI immediately**
  (`agentic-net-gui`, Session panel). The state chip and action button
  used to keep showing the previous value after a successful
  Activate/Deactivate request, even though the backend had already
  transitioned. The chip and button now refresh as soon as the request
  returns. The bulk action previously labelled "Catalogue All" is now
  labelled "Unload All" with a clearer tooltip — it unloads loaded
  models from memory so they become `CATALOGED`.
- **Tool-net invocations resolve and poll correctly**
  (`agentic-net-master`, `INVOKE_TOOL_NET`). Two silent failure modes
  in tool-net invocations are fixed. The per-net manifest leaf is now
  read by enumerating the net container's children instead of being
  looked up as an inline property (it isn't one). The result-place
  poll resolves runtime places under `/root/workspace/places/` to a
  UUID up front using the full path, so polling no longer returns
  empty when the result place lives outside `/sessions/`.
- **Runtime-created models stay visible across unload cycles**
  (`agentic-net-node`, model catalog). Models created at runtime via
  the events API or directly through the mediator (without going
  through disk-scan cataloguing) used to vanish from
  `GET /api/admin/models` after an unload — they were dropped from
  the in-memory registry but never written into the catalog as
  `CATALOGED`. The catalog is now refreshed on list, runtime-created
  models are explicitly registered on create, and unload promotes
  them to `CATALOGED` instead of dropping them. They remain visible
  without needing a node restart.
- **`POST /api/admin/models/{modelId}/load` no longer wipes loaded
  state** (`agentic-net-node`). When called against a model already
  loaded in the registry, the endpoint used to re-invoke
  `loadFromPersistence`, which in the absence of a snapshot reset the
  model to version 0 ("No snapshot found, starting with empty state")
  and discarded everything in memory. The endpoint is now a no-op for
  already-loaded models — load only runs for cataloged-but-not-loaded
  models that need to be brought into memory.

## [2.2.1] - 2026-04-25

### Fixed
- **Chat container restart loop on missing token** (`agentic-net-chat` —
  `src/index.ts`). When `TELEGRAM_BOT_TOKEN` was empty (the default for
  fresh installs and any deployment without an explicit token), the process
  exited with code `1` and Docker's `restart: unless-stopped` policy spun
  the container in a tight restart loop, polluting `docker logs` and burning
  CPU. The container now stays alive in an idle state and prints a clear
  hint so the operator can set the token and restart, without churn.

### Changed
- **README rewrite** with new positioning ("Governed multi-agent runtime.
  Your agents stop running naked."), three new sections explaining what
  nets model in practice ("What you can model with it", "Net of nets",
  "Example net"), and embedded screenshots illustrating multi-net runtime
  composition and a sample crawler net. Replaces the previous license-first
  landing page.

### Added
- **Repository visual assets** (`.github/images/`): `agentic-nets-icon.svg`
  (project icon), `agent-control-overview.png` (multi-net runtime view),
  `simple-crawler-net.png` (example net diagram). Referenced from README.

## [2.2.0] - 2026-04-25

### Added
- **Configurable agent loop limits** (`agentic-net-cli`). `max_iterations` and
  `max_tool_calls` are now first-class fields in the CLI profile config.
  Previously hardcoded (ask: 30 iter / 24 tools; chat: 40 iter / 30 tools),
  they now default to 100/100 and are overrideable per profile or via
  `AGENTICOS_MAX_ITERATIONS` / `AGENTICOS_MAX_TOOL_CALLS` environment
  variables. `agentic-net-cli config init` writes these fields into the
  generated profile. `agentic-net-cli config show` displays current values.
- **Token lock release on executor abort** (`agentic-net-executor`). A new
  `POST /api/transitions/tokens/release` call to master is made when the
  executor aborts a transition mid-flight. This removes the `_lock` reservation
  property from tokens that were selected but not consumed, preventing them from
  staying permanently locked after a stop.
- **Local dev infrastructure compose** (`deployment/docker-compose.local-infra.yml`).
  New compose file for Mac local development containing only the infrastructure
  services (Grafana, Prometheus, Tempo, OTel Collector, OpenBao, OCI registry).
  Native services (node, master, gateway, executor, blobstore, vault, GUI) are
  expected to run via Maven/npm directly on the host. Replaces the earlier
  full-stack compose for local workflows.
- **README product preview video**. YouTube thumbnail and watch link added to
  the repository landing page.

### Fixed
- **Executor stop race condition** (`agentic-net-executor` — `TransitionOrchestrator`).
  Two guard layers now prevent a FIRE from executing when STOP has already
  arrived: a pre-submit guard checks the local transition status before
  submitting to the thread pool, and a post-submit guard re-checks inside the
  worker thread before calling `runSingleWithBoundTokens`. The abort path also
  calls `releaseTokens` on master to clean up any locks taken during the
  now-cancelled firing.
- **ConsumptionService refactored** (`agentic-net-executor`). The
  `toTokenReferences` helper is now shared between consume and release paths,
  removing duplicated parentPlace extraction logic and unifying log messages.

### Changed
- **Prometheus scrape config** updated to reflect the local-infra compose
  topology (native services scraped via `host.docker.internal:<port>` rather
  than container names).
- **sa-blobstore single-node profile** (`application-single.properties`) updated
  to avoid binding port 8080, which conflicts with agentic-net-node on the
  same host.

## [2.1.10] - 2026-04-24

### Added
- **Seeded knowledge catalog** (master). On startup, `agentic-net-master`
  writes 37 system-knowledge blobs (transition-language docs, ArcQL
  parser/executor/syntax-checker source, inscription validator, emit-rule
  checker, designtime/runtime/deployment source, Docker tool runtime docs,
  6 real inscription examples) to `sa-blobstore` under stable
  `knowledge-seed/...` blob IDs. `SEARCH_KNOWLEDGE` now merges these
  seeded hits with any model-owned knowledge tokens, so the builder
  persona can answer "show me an HTTP transition example" or "what fields
  does the inscription validator require" without a pre-populated user
  model. `READ_BLOB_TEXT` retries via seed-on-demand if the blob is
  missing at fetch time. Configurable via `AGENTICOS_KNOWLEDGE_CATALOG_ENABLED`
  and `AGENTICOS_KNOWLEDGE_SEED_BLOBS_ENABLED` (both default `true`).
- **Docker tool registry seeder** (`deployment/scripts/seed-tool-registry.sh`).
  One-shot `docker compose --profile tools run agenticos-tool-seeder`
  mirrors the approved `agenticos-tool-*` images from Docker Hub into
  the bundled local OCI registry on `localhost:5001`. Agents are
  allowlisted to run only `localhost:5001/agenticos-*`, so this is the
  supported path to introduce new tool images without loosening the
  allowlist. `AGENTICOS_TOOL_SEED_MODE=build` builds from
  `../agentic-net-tools/` for contributor workflows.

### Fixed
- **Master → BlobStore connectivity.** `BlobStoreClient` default base URL
  was `http://localhost:8090`, which inside the master container resolves
  to master itself, not to `sa-blobstore`. Added
  `BLOBSTORE_BASE_URL=http://sa-blobstore:8080` to the master service in
  all three compose files. Without this, the new knowledge-catalog
  seeding failed with connection-refused errors and `READ_BLOB_TEXT`
  traffic went nowhere.
- **Knowledge-catalog seeding retry window.** BlobStore takes ~30 s to
  become ready after master starts; the initial 3-attempt / 12 s retry
  window was too short and all attempts failed before BlobStore accepted
  connections. Raised to 10 attempts with a 10 s per-attempt backoff
  cap (~90 s total).
- **`init-perms` idempotency.** The one-shot init container's
  `addgroup -S agenticnet && adduser -S -G agenticnet agenticnet` failed
  on repeat `docker compose up` runs with `addgroup: group 'agenticnet'
  in use` when docker re-executed the stopped container. Replaced with
  `getent`-guarded variants so the step is safe to re-run against
  pre-existing group/user entries.

### Changed
- **`ollama signin` (canonical) replaces `ollama login` in all docs.**
  `ollama login` is a legacy alias. Added a full walk-through for
  authenticating the bundled Ollama container against `ollama.com` after
  `docker compose up`, an `ssh -t` tip for remote shells, and a
  manual fallback via <https://ollama.com/settings/keys> for
  environments where the `/connect` endpoint rejects the URL format.
- **`.env.template` CORS checklist moved to the top of the file** so
  first-time operators putting the Studio behind a public domain see the
  requirement to add their origin to `GATEWAY_CORS_ALLOWED_ORIGIN_PATTERNS`
  and `AGENTICOS_CORS_ALLOWED_ORIGIN_PATTERNS` before they hit the
  browser-side `HTTP 403 Invalid CORS request` on login.
- **Builder-persona prompts tightened**: new `FOCUSED NET TARGET` rule
  (use the focused netId instead of creating a parallel net),
  `DOCKER TOOL KNOWLEDGE` rule (search the seeded docker-tool-runtime
  blob before designing a tool branch), `AGILE TEAM REFERENCE` rule
  (reuse the seeded agile-team inscription bundle for multi-role
  software-delivery workflows), and a hard `CREATE_NET` guard that
  rejects the tool call when the context carries a `focusedNetId` and
  the user did not explicitly ask for a separate net.
- **Dashboard**: new "Agentic-Nets Studio" promo card surfacing the
  visual-builder entry point from the landing page.

## [2.1.9] - 2026-04-23

### Summary
Foundational release for the seeded knowledge catalog and tool-registry
seeder. Superseded by 2.1.10, which adds the BlobStore wiring fix,
`init-perms` idempotency, and the `ollama signin` documentation that
makes the default cloud LLM profile work end-to-end out of the box.
**Use 2.1.10.**

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

---

Earlier 2026-Q1 releases (`v1.19.0`, `v1.18.0`, `v1.15.0`, `v1.11.0`–`v1.14.0`,
`v1.9.0`, `v1.6.0`) are archived in
[`changelogs/CHANGELOG-2026-Q1.md`](changelogs/CHANGELOG-2026-Q1.md), which
also covers the pre-release dev history that produced the launch tag `v1.2.0`.
