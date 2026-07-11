# Changelog

All notable changes to the AgenticNets open-source services are documented here.

This file holds only the **current calendar quarter's** releases. Older
quarters are archived under [`changelogs/`](changelogs/) — see
[`changelogs/README.md`](changelogs/README.md) for the index. At the end of
each quarter, the entries below get moved into a new `changelogs/CHANGELOG-YYYY-Qn.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.22.0] - 2026-07-11

### Added
- **Dedicated executor OAuth2 client with scope enforcement** (`agentic-net-gateway` — `TokenController`, `AdminSecretInitializer`, new `ExecutorScopeEnforcementFilter`). A third client `agenticos-executor` (secret auto-generated to `data/jwt/executor-secret`, or pinned via `AGENTICOS_EXECUTOR_SECRET`) issues JWTs with scope `agenticos executor` that are enforced to the executor polling protocol ONLY — `GET /api/transitions/poll|discover`, `POST /api/transitions/{id}/deployment` and `POST /api/transitions/tokens/emit|consume|release`; every other route answers `403 executor_scope`. Remote executors no longer need to hold the full admin secret.
- **Executor secret-from-file auth** (`agentic-net-executor` — `MasterPollingService`). New `executor.upstream.auth.client-secret-file` (`EXECUTOR_AUTH_CLIENT_SECRET_FILE`): the client-credentials secret is read lazily from a mounted file at each token fetch, so the gateway-generated `executor-secret` may appear *after* the executor boots (fresh `docker compose up` ordering) and is picked up without a restart. Inline `EXECUTOR_AUTH_CLIENT_SECRET` still wins when set. JWTs are re-fetched ~60s before expiry, making the machine-auth flow long-term valid without refresh tokens.
- **Two executors in every compose file, polling through the gateway** (`deployment/docker-compose.yml`, `docker-compose.hub-only.yml`, `docker-compose.hub-only.no-monitoring.yml`, `.env.template`). A second executor instance `agentic-net-executor-2` (id `agentic-net-executor-2`, host port 8086) runs alongside the default one; BOTH now poll `http://agentic-net-gateway:8083` with the executor client instead of hitting master unauthenticated. Per-executor knobs: `EXECUTOR_ID`/`EXECUTOR_2_ID`, `EXECUTOR_MODELS`/`EXECUTOR_2_MODELS`; direct-master mode remains available (`EXECUTOR_UPSTREAM_URL` + blank `EXECUTOR_AUTH_CLIENT_ID`). A command transition picks its executor via the inscription's `action.executorId` (see `core/CHANGELOG.md`).
- **Multi-master compose topology** (`deployment/docker-compose.multi-master.yml`). Two masters (ports 8082/8087) partitioned by model (`MASTER_1_MODELS`/`MASTER_2_MODELS`, keep disjoint) self-register with the gateway (no seed master: blank `MASTER_URL`), plus the two executors — the staging-validation topology for the multi-master + multi-executor path.

- **Reactive re-authentication on 401 for all client-credentials clients** (`agentic-net-executor` — `MasterPollingService`; `agentic-net-cli` — `GatewayClient`, inherited by `agentic-net-chat` and `agentic-net-mcp`). The client-credentials grant has no refresh token — a fresh request to `/oauth2/token` IS the refresh — but until now a token invalidated mid-window (gateway signing-key rotation, stale token file on disk) was trusted until its local expiry: the executor would poll with a dead JWT for up to a full TTL, and the CLI's disk-persisted token poisoned every run. Now any 401 received while holding a cached token discards the cache, re-authenticates with the client secret, and retries the request exactly once.

- **Multi-executor awareness for MCP clients and CLI agents** (`agentic-net-mcp` — new curated `list_executors` tool (also in readonly mode), `executorId` parameter on `add_transition` (kind `command`; a concrete id doubles as the `assignedAgent`, `"*"` keeps the default assignment), instructions/docs teaching the contract; `agentic-net-cli` — new native `LIST_EXECUTORS` read tool (`GET /api/executors` via gateway), auto-exposed by the MCP native layer and inherited by chat). Tool descriptions instruct agents: when more than one executor is ONLINE and the user hasn't specified one, ASK which executor to target before creating the command transition.

- **Centralized log aggregation — Loki + Alloy join the monitoring stack** (`deployment/docker-compose.yml`, `docker-compose.hub-only.yml`, `docker-compose.local-infra.yml` (behind the existing `monitoring` profile), `monitoring/docker-compose.yml`; new `monitoring/config/loki.yaml` + `monitoring/config/alloy-config.alloy`; Grafana `datasources.yaml`). Alloy tails every container's stdout/stderr through the Docker API (socket mounted read-only — no application changes, works on Linux and Docker Desktop alike) and pushes to Loki (port 3100, localhost-bound). Logs are queryable in Grafana Explore with `project`/`service`/`container` labels, and the standard log pattern's `[trace_id,span_id]` field is a derived link straight to the Tempo datasource. Loki ships HARD-CAPPED from day one — 72h retention, 5 MB/s ingestion (the tempo-overload lesson, applied preemptively). New `.env` keys: `LOKI_IMAGE`, `ALLOY_IMAGE`, `LOKI_PORT`.
- **Timestamped log helpers for the Node/TS services** (`agentic-net-cli` — `src/util/logger.ts`; `agentic-net-chat` — `src/logger.ts`; `agentic-net-mcp` — `src/logger.ts`). Service diagnostics now carry `YYYY-MM-DD HH:mm:ss.SSS LEVEL` prefixes matching the Java services' pattern, so aggregated logs read uniformly. Stream discipline per process type: CLI diagnostics go to stderr (stdout stays clean for command output and piping), MCP logs stderr-only (stdout is the protocol channel), chat logs info to stdout / warnings+errors to stderr. No new dependencies; user-facing CLI rendering is untouched.

### Changed
- **One standard logback configuration across all Java services** (`agentic-net-gateway`, `agentic-net-executor`, `agentic-net-vault`, `sa-blobstore` — `logback-spring.xml` + `application.properties`; mirrored in core/, see `core/CHANGELOG.md`). Console AND rolling file are always on with one shared pattern (`yyyy-MM-dd HH:mm:ss.SSS [thread] LEVEL logger [trace_id,span_id] - msg`), and rollover is unified at 50MB / 7 days / 500MB total cap. The standard Spring `logging.logback.rollingpolicy.*` properties are now wired into logback via springProperty hooks and actually take effect — previously they, `logging.file.name`, and the empty `logging.pattern.console=` "console disable" were silently dead config overridden by the custom logback files (executor and vault logged to console despite the properties saying otherwise). The dead properties were removed.
- **Gateway logs INFO by default** (`agentic-net-gateway` — `application.properties`, `logback-spring.xml`). The own-package DEBUG default narrated every executor poll through the proxy — ~156k stdout lines/day with two executors. Now INFO; raise the level env only when debugging routing.

### Fixed
- **Gateway/executor black-holed recreated containers for up to 10 minutes** (`agentic-net-gateway` — new `ProxyWebClients` factory used by all proxy controllers; `agentic-net-executor` — `MasterPollingService`). Reactor-Netty's default DNS resolver caches lookups honoring the DNS record TTL, and Docker's embedded DNS hands out **600s** — so after `docker compose up -d <service>` recreated a master with a new IP, the gateway kept connecting to the dead address ("Connection refused" to the old IP while Docker DNS already served the new one; observed live after a master roll). All inter-service WebClients now use the JDK resolver (~30s positive cache), making recreated containers reachable again within seconds. Same fix applied to the master's WebClients (see `core/CHANGELOG.md`).
- **Multi-master executor list fan-out returned an empty array** (`agentic-net-gateway` — `MasterProxyController`). The `/api/executors` fan-out merge only understood a bare JSON array upstream, but the master actually answers `{generatedAt, count, executors:[...]}` — so with two or more registered masters the gateway always returned `[]` while each master's own registry was fully populated (found live on the first Mac multi-master deployment; the old test had stubbed the wrong upstream shape). The merge now reads the `executors` array (bare arrays still accepted) and returns the same object shape as the single-master pass-through.
- **Gateway heartbeat no longer silently acknowledges unknown masters** (`agentic-net-gateway` — `MasterRegistryService`, `MasterRegistrationController`). After a gateway restart wiped the in-memory master registry, heartbeats from already-registered masters returned 200 as a no-op — the master believed it was registered while the gateway routed nothing to it, permanently. Heartbeat now returns `404 {"error":"unknown_master"}` for unregistered masters so they re-register (the master side re-registers automatically; see `core/CHANGELOG.md`).

## [2.21.2] - 2026-07-09

### No code changes — released for parity with sibling repo (see `core/CHANGELOG.md` for the actual changes).

## [2.21.1] - 2026-07-08

### Added
- **"The Harness Control System" whitepaper** (`docs/whitepaper/`). A self-contained, print-ready HTML whitepaper on the harness-control thesis — the six-layer stack, the observe/analyze/improve/measure control loop, crystallization economics, the self-building loop and its guardrails, and NetHub multiplication — linked from the README's Start-here table and architecture section. No code changes this cycle; see `core/CHANGELOG.md` for the actual service fixes in this release.

## [2.21.0] - 2026-07-07

### Fixed
- **A null command-token meta value can no longer wedge a command lane** (`agentic-net-executor` — `CommandResult`). `Map.copyOf` throws a bare NPE on null values, and command tokens routinely carry a template-resolved null (e.g. `{"_correlationId": null}` when an upstream field was missing). That NPE fired on both the success and failure construction paths, so the executor never produced a result, the token was never consumed, and the transition retried every ~2 s indefinitely (a real staging incident wedged the safe-teams QA test lane). The meta copy now drops null entries. +5 regression tests including the exact incident shape.

## [2.20.0] - 2026-07-07

### Changed
- **Agent renames mirrored from core: Genesis → Persona, Maestro → Genesis** (`agentic-net-mcp`, `agentic-net-cli`, `claude-plugin/agenticos-control`, docs). The MCP `invoke_agent` AGENTS list and docstrings, CLI agent tools, and the agenticos-control plugin references (personas/recipes/skill/README) now address the persona-creator meta-agent as **`persona`** (formerly `genesis`) and the command-room agent as **`genesis`** (formerly `maestro`); `persona-inhabited` / `p-persona-*` replace the old `genesis-inhabited` / `p-genesis-*` conventions. ⚠️ If you script against `invoke_agent`, update `genesis` → `persona` where you meant the persona-creator (see `core/CHANGELOG.md` for the full breaking-change notes).

## [2.19.0] - 2026-07-07

### Added
- **Executor command capability for agents — large output offload** (`agentic-net-executor` — `BashCommandHandler`, `BlobStoreClient`). When a command's stdout/stderr exceeds `executor.command.stdout.max-inline-bytes` (default `131072` = 128 KB, safely under the master's 256 KB inbound codec limit), the full stream is uploaded to the blobstore and the result carries a short preview plus `stdoutUrn` / `stdoutBytes` / `stdoutTruncated` instead of the whole payload. This is what lets Maestro (see `core/CHANGELOG.md`) run commands that produce huge output and then inspect it with the blob analysis tools rather than overflowing the wire. Small outputs stay fully inline — no behavior change for ordinary commands.
- **Config-driven command allow/deny gate** (`agentic-net-executor` — `BashCommandHandler`). A forward-looking policy on bash commands: `executor.command.bash.denylist` and `executor.command.bash.allowlist` (`EXECUTOR_BASH_DENYLIST` / `EXECUTOR_BASH_ALLOWLIST`, comma-separated case-insensitive regexes). A denylist match is always rejected; if an allowlist is set the command must match one entry. Both default empty = allow everything, so there is no change to current behavior until an operator opts in.
- **MCP domain-memory tools** (`agentic-net-mcp` — `domain_memory_write` / `domain_memory_recall`). Store and recall memory in a model's own domain net (`p-{model}-domain-{knowledge|journal|insights}`) — the same per-model memory base the master's `MEMORY_WRITE` / `MEMORY_RECALL` tools and the domain-expert persona use — alongside the existing `p-mem-*` working-memory tools. `domain_memory_recall` is allowed in read-only mode.
- **CLI/MCP tool parity with the agent surface** (`agentic-net-cli`, `agentic-net-mcp`). The native tool layer tracks the platform agent catalog, adds an `invoke_agent` tool, and ships an OpenCode quick-start for the MCP server.

## [2.18.2] - 2026-07-05

### Changed
- **Deployment pinned to 2.18.2** (`deployment/` — `.env.template`, `docker-compose.yml`, `docker-compose.hub-only.yml`, `docker-compose.hub-only.no-monitoring.yml`). `AGENTICNETOS_VERSION` now defaults to `2.18.2` so `docker compose up` runs the current image set, which includes the `agentic-net-master` hotfixes 2.18.1–2.18.2 (reject unavailable tool calls; knowledge-seed docs work under `java -jar` + classpath fallback — see `core/CHANGELOG.md`). The open-source services (gateway, executor, vault, cli, chat, blobstore) are unchanged from 2.18.0 and are republished under the 2.18.2 tag for a consistent, reproducible set.

## [2.18.0] - 2026-07-05

### Added
- **MCP server — NetHub tools + major capability expansion** (`agentic-net-mcp`, now 104 tools). Curated NetHub tools: `hub_publish` (net/session/model, versioned, credential-scrubbed), `hub_search` (compact, paginated, true totals — local or a peer via `remote`), `hub_show` (inspect an artifact's versions / kind / token policy / readme / size before installing), `hub_install` (a model artifact creates a new model that is immediately targetable), `hub_add_remote` (P2P federation). Plus client-hosted transitions (`host_transition`/`unhost_transition` — the MCP process runs llm/agent lanes locally via the CLI), autonomous personas (`spawn_persona`), session crystallization, a model kill switch (`pause_model`/`resume_model`), full model lifecycle (`create_model`/`list_models`), and `DELETE_TRANSITION`. The native UPPERCASE tool layer now tracks the full platform catalog automatically.
- **NetHub client surface + gateway opt-in public catalog** (`agentic-net-cli` `HUB_*` tools; `agentic-net-gateway`). Gateway `gateway.hub.public-catalog` (`AGENTICOS_HUB_PUBLIC_CATALOG`, default `false`) permits anonymous GET `/api/hub/public/**` and folds `/api/packages/**` GET under the same flag — the default is now "no token ⇒ nothing".

### Changed
- **Default Ollama models migrated off retiring cloud models** (`agentic-net-cli` config; `deployment/.env.template`, `deployment/README.md`). Matching core: tiers on `deepseek-v4-pro:cloud` (low `deepseek-v4-flash:cloud`), post-THINK `glm-5.2:cloud`, replacing the retiring `deepseek-v3.1:671b` / `gemini-3-flash-preview` / `qwen3-coder:480b`.

### Fixed
- **MCP `hub_search` output** (`agentic-net-mcp`). Returns a compact projection with `limit`/`offset` paging (local and remote) and an honest "showing N of M / how to page" hint, instead of dumping up to 50 full artifact objects with a page-size `total`.

## [2.17.0] - 2026-07-03

### Added
- **agenticos-control Claude Code plugin** (`claude-plugin/agenticos-control/`, `.claude-plugin/marketplace.json`). Drive a running AgenticNetOS stack from Claude Code: two agents (net designer, net operator), six slash commands (`/agenticos-inspect`, `-doctor`, `-fire`, `-persona`, `-forge`, `-export`), a skill with eight reference docs, and a CLI-first/curl-fallback dispatcher supporting gateway OAuth2 or direct auth (secrets from env/file only, never printed). Install: `/plugin marketplace add alexejsailer/agentic-nets` → `/plugin install agenticos-control@agentic-nets`.
- **Thinking-model configuration pass-through** (`deployment/` — `docker-compose.yml`, `docker-compose.hub-only.yml`, `.env.template`). New optional `OLLAMA_THINKING_MODEL` / `CLAUDE_THINKING_MODEL` keys reach `agentic-net-master` and enable its new dynamic post-THINK model routing for agent sessions (see `core/CHANGELOG.md`). Blank (the default) leaves routing off.

### Changed
- **Test hardening** (`agentic-net-executor`, `agentic-net-gateway`, `agentic-net-vault`, `sa-blobstore`). +218 hermetic tests for previously zero-coverage features (command dispatch, credentials cipher, token rate limiting, JWT/admin-secret bootstrap, two-phase upload durability, cluster health, and more). No wire-format or configuration changes.

