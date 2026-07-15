# Changelog

All notable changes to the AgenticNets open-source services are documented here.

This file holds only the **current calendar quarter's** releases. Older
quarters are archived under [`changelogs/`](changelogs/) — see
[`changelogs/README.md`](changelogs/README.md) for the index. At the end of
each quarter, the entries below get moved into a new `changelogs/CHANGELOG-YYYY-Qn.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.30.0] - 2026-07-15

### Added
- **`start_domain_expert` MCP tool** (`agentic-net-mcp` — `tools/agents.ts`). Bootstraps the domain-expert as a first-class, self-maintaining inhabitant of a model: `POST /api/assistant/p/domain-expert/{model}/chat/start` creates the domain-memory skeleton (`p-{model}-domain-{entrypoints,routing,knowledge,journal}`) AND the scheduled `t-{model}-domain-maintain` agent that keeps it filled. `invoke_agent{agent:"domain-expert"}` answers one-shot but never bootstraps, so a fresh model's domain expert had no durable, auto-refreshed memory until now. Idempotent (`domainBootstrap: created|existing`).

### Fixed
- **New-model runtime places no longer need a template first** (`agentic-net-cli` — `agent/tool-executor.ts`). A model minted by `create_model` has only the ROOT sentinel, which is not a child of anything — so provisioning the first runtime place (`root/workspace/places`) threw "root segment 'root' is missing" and `add_place`/`CREATE_RUNTIME_PLACE` were unusable until a template was deployed. `ensureNodePath` now seeds the well-known ROOT id directly, matching how the MCP tree helper already resolves `root`.
- **Native token/place tools accept `placeId`** (`agentic-net-mcp` — `tools/catalog.ts`). `CREATE_TOKEN`/`DELETE_TOKEN`/`QUERY_TOKENS`/`GET_PLACE_INFO`/`INSPECT_TOKEN_SIZE`/`EXTRACT_TOKEN_CONTENT` demanded `placePath` (which actually wants the short place id) and rejected the `placeId` the curated tools take — a schema-validation reject before the handler's own alias logic ran. They now advertise `placeId` and no longer force `placePath`.
- **Scheduled http/llm lanes re-read their config instead of draining it** (`agentic-net-mcp` — `inscriptions.ts`). A scheduled (`scheduleCron`/`intervalMs`) http or llm lane consumed its input token and fired once; `buildHttpInscription`/`buildLlmInscription` now set `consume:false, optional:true` on scheduled lanes like map/command/agent already did — enabling a nightly fetch that re-reads a persistent config token each tick.
- **`fire_once` states it is disabled for llm/agent lanes** (`agentic-net-mcp` — `tools/nets.ts`). The tool description now says to run those server-side via `start_transition` or client-side via `host_transition`/`EXECUTE_TRANSITION_SMART`, instead of surfacing an opaque engine error.
- **`QUERY_TOKENS` truncation hint points to the actual fix** (`agentic-net-cli` — `agent/tool-executor.ts`). The auto-truncation hint pointed at `EXTRACT_TOKEN_CONTENT` (whose property mode returns a metadata wrapper — a dead end); it now says to re-query with a larger `maxValueLength` and explains the `[truncated, N chars total]` marker.

## [2.29.0] - 2026-07-15

### Added
- **Tool-catalog, cost, and NetHub knowledge in the MCP pack** (`agentic-net-mcp` — `src/knowledge/{tool-catalog,cost,nethub}.md`). Three new bundled docs (17 total) teaching the concepts from the July platform posts: the full positional `rwxhludcts` capability string (with the d/h/t/s binding-type flags and the authoring-vs-invoking W/T split), the global + per-model local-first tool catalog (shadowing, contract-vs-binding, the sha256 double-check that makes `approved` cryptographic), the token-cost meter loop (measure → rank → retune → watch, including the invisible script-spawned-model-call category), and NetHub export/import (all seven publish kinds, self-contained packages, scope-aware install, federation).
- **`usage_report` MCP tool** (`agentic-net-mcp` — `tools/observe.ts`). Wraps the master's per-transition token meter (`/api/usage/transitions`): ranked burn with per-fire averages and the scheduled-vs-work `burnSplit`, plus per-transition drill-down. GET-based, readonly-safe — the entry point of the cost loop.

### Fixed
- **`spawn_persona` execute-personas could not invoke tool-nets** (`agentic-net-mcp` — `tools/nets.ts`). The `execute` capability granted `rwxhl`, but the persona's own instruction tells it to `DESCRIBE_TOOL_NET`/`INVOKE_TOOL_NET` — which the engine gates behind the `t` flag. The grant is now `rwxhl---t`, and every role-string description names the real positional `rwxhludcts` model.
- **Native `HUB_PUBLISH`/`HUB_CATALOG` schemas caught up with the hub API** (`agentic-net-cli` — `agent/tools.ts`). They only advertised `net|session|model`; the master has supported `toolnet|tool|catalog|blob` (with `toolId`/`catalogScope`/`blobUrns`) since 2.26 — the native layer now exposes them like the curated `hub_publish` does.

## [2.28.0] - 2026-07-14

### Added
- **Bundled knowledge pack — work over MCP like you have the source** (`agentic-net-mcp` — `src/knowledge/*.md`, `src/tools/knowledge.ts`, `resources.ts`). Fourteen curated operational docs (concepts, the PNML-vs-runtime two-layer architecture, per-kind inscription templates, ArcQL, template interpolation + functions, emit semantics, command lanes + executors, LLM-transition failure modes, scheduling, token shapes, troubleshooting playbooks, recipes, security) compiled INTO the MCP binary and served as `agenticnets://docs/{topic}`. New **`search_knowledge`** tool greps the pack offline (registered in readonly mode too — zero network, zero mutation) and returns topics + excerpts + resource URIs. A new **leak-gate test** scans every shipped string (docs, instructions, templates) for credentials, IPs, personal paths, internal hostnames, and CI details, plus enforces size caps (8KB/doc, 64KB pack, 15KB instructions) — curated rewrites of private knowledge ship safely by construction.
- **`scheduler_status` MCP tool** (`agentic-net-mcp` — `tools/observe.ts`). Per scheduled transition: `lastFiredAt`/`lastFiredAgo`, `nextFireAt`, live status, `ready`, `eligibility` (on masters ≥ 2.28), and an `overdue` flag with a recovery hint when the scheduler has not re-armed a lane (the classic post-redeploy freeze). Answers "my autonomous nets silently stopped" in one call. GET-based, readonly-safe.
- **`llm_health` MCP tool** (`agentic-net-mcp` — `tools/observe.ts`). Wraps the master's LLM-provider health check (READY / MODEL_NOT_FOUND / UNREACHABLE) with a cost warning — the pre-flight for building any llm/agent lane. GET-based, readonly-safe.

### Fixed
- **MCP-created agents silently ran without their granted capabilities** (`agentic-net-mcp` — `inscriptions.ts`). The agent builder wrote `role` only at the inscription root, but the engine reads it exclusively from `action.role` — so every `spawn_persona`/`add_transition` agent (including `capability:"execute"` workers) actually ran as `rw--` (no commands, no tool-nets). The role now lands in `action.role`.
- **`LIST_ALL_INSCRIPTIONS` naming trap defused** (`agentic-net-cli` — `agent/tools.ts`). Its description now states that it returns bare ids without `includeContent:true` and points at the curated `list_transitions` (which cross-references back) — an agent field report lost an hour to this and published a wrong conclusion.
- **Token stringification documented at point of use** (`agentic-net-mcp` — `query_tokens` description + the tokens knowledge doc). Nested objects/arrays round-trip as JSON-encoded strings; consumers must parse (sometimes twice for LLM output).

## [2.27.0] - 2026-07-14

### Added
- **Executor-coverage diagnostics in the MCP** (`agentic-net-mcp` — `tools/observe.ts`). `net_stats` gains an `executorCoverage` block, `list_executors` returns a `coverageForModel` verdict (`covered` / `allowedButIdle`) plus a field guide reconciling `status`/`connected` and `models`/`allowedModels`, and `diagnose_transition` adds an executor-coverage check for command transitions. A command lane can look RUNNING with a full queue yet never fire when no executor is polling its model; these surface that where an agent already looks instead of behind a tool nobody thinks to call.
- **`list_transitions` MCP tool** (`agentic-net-mcp` — `tools/observe.ts`). Every transition's kind, schedule, live status, action type, and input/output places in one call — the model-audit read, far cheaper than one `GET_TRANSITION` per id. Degrades to id+status under the readonly scope.
- **`set_transition_credentials` MCP tool** (`agentic-net-mcp` — `tools/nets.ts`). Stores per-transition secrets vault-backed (`POST /api/transitions/{id}/credentials`), so the documented `${credentials.KEY}` secure-injection path is reachable from MCP instead of forcing secrets into inscriptions or event-sourced tokens. Never echoes secret values back.
- **Rich `http` on `add_transition`** (`agentic-net-mcp` — `tools/nets.ts`, `inscriptions.ts`). `add_transition` kind:http now accepts `headers`, `body`, `auth`, `retry`, `emit`, and `errorPlace`, so an authenticated HTTP net is buildable without hand-authoring inscriptions; `errorPlace` splits success/error emits so a failed call lands somewhere visible.

### Changed
- **`net_overview` can no longer be misread as model-wide** (`agentic-net-mcp` — `tools/observe.ts`). Without a `netId` it returns `sessionNetCount`/`sessionNets` (renamed from `netCount`/`nets`) plus a model-wide `modelSessionCount`/`sessionIds`, so a freshly-connected empty session is not mistaken for an empty model. Accepts an explicit `sessionId`.
- **`create_model` checks the node, not the allowlist** (`agentic-net-mcp` — `tools/nets.ts`). A model that is allowlisted but absent on the node is now created rather than reported as already present.
- **`event_trail` pages backwards and caps its window** (`agentic-net-mcp` — `tools/observe.ts`). New `before` param walks into older history; `limit` is capped at 200 (a large page could truncate into invalid JSON).
- **`placeId`/`place` accepted everywhere a place is expected** (`agentic-net-cli` — `agent/tool-executor.ts`; `agentic-net-mcp` — `query_tokens`). No more failed call + retry across three argument names.

### Fixed
- **`CREATE_RUNTIME_PLACE` provisions its parent chain** (`agentic-net-cli` — `agent/tool-executor.ts`). A brand-new model has only `root`; creating a place under the missing `root/workspace/places` used to 404. It now ensures the container path, fixing `add_place` and persona creation on fresh models.
- **`DEPLOY_TRANSITION` no longer silently no-ops** (`agentic-net-cli` — `agent/tool-executor.ts`). Without an inscription parameter it returned success while assigning nothing; it now assigns the effective inscription, routed by kind (command → executor, else master).
- **`add_place` reports partial state** (`agentic-net-mcp` — `tools/nets.ts`). On a runtime-half failure it returns `{designtime:true, runtime:false, error}` instead of throwing.
- **Gateway 404s name the resource** (`agentic-net-cli` — `gateway/client.ts`). `GatewayError` now includes the attempted `METHOD /path`, so a not-found says which model/net/place/parent was missing.

## [2.26.0] - 2026-07-13

### Added
- **`hub_publish` gains the dependency-aware kinds — `toolnet`, `tool`, `catalog`, `blob`** (`agentic-net-mcp` — `tools/hub.ts`; `agentic-net-cli` — `master-api.ts`, inherited by chat). The MCP `hub_publish` / `hub_search` tools now expose the four new kinds plus the `toolId` / `catalogScope` / `blobUrns` source fields that drive them; the tool description explains that any script/http/docker/tool-net dependency an artifact uses now travels with it, sha256-pinned, so it runs after install on another instance. See `core/CHANGELOG.md` for the packaging itself.
- **"Portable packages (NetHub)" section in the tools guide** (`agentic-net-tools/README.md`). Documents self-contained packages, the four new publishable kinds and where each installs, the scope-aware re-materialization (docker/http → global, script/tool-net → the installed model), and the package integrity hash.

### Changed
- **Isolated dev/test stack runs blobstore and polls the master directly** (`deployment/docker-compose.test.override.yml`, `.env.test`). The `agenticos-test` stack now includes `sa-blobstore` (NetHub package payloads and script tools live there) and, with no gateway in that stack, its executor polls the master directly (`EXECUTOR_UPSTREAM_URL` + a blank client id); the override drops the executor's gateway health-dependency to match. Internal CI/test tooling — no runtime behavior change.

## [2.25.1] - 2026-07-12

### Fixed
- **No code changes in this repo — released for parity with `core/`** (the 2.25.1 fix is a master-side script-resolution bug; see `core/CHANGELOG.md`). The version tag is created in both repos by the release pipeline.

## [2.25.0] - 2026-07-12

### Added
- **S (scripts) flag + scoped-catalog params in the CLI** (`agentic-net-cli` — `roles.ts`, `tools.ts`, `tool-executor.ts`, regenerated `tools.generated.ts`; inherited by chat and MCP). The role string grows to `rwxhludcts`: script-catalog registration moves off D onto the new S flag, HTTP registration moves onto H, and catalog search/get are granted by any binding-type flag (D/H/T/S). Catalog search/get/register-script gain an optional `model` param for local-vs-global scope. The MCP native layer subsumes that scope param into its own model routing, so a search resolves the routed model's local catalog first, then the global one (single-model MCP configs still advertise no `model` param). See `core/CHANGELOG.md` for the catalog scoping itself.
- **Script command handler — catalog scripts run digest-verified on the executor** (`agentic-net-executor` — new `ScriptCommandHandler`, executor type `script`, command `invoke`; config `executor.command.script.{timeout,cache-dir,max-bytes}`). The master inlines a registered script's content + pinned SHA-256 into the command token at FIRE time; the handler re-verifies the digest (refusing anything that doesn't hash to what was registered, including a tampered cache file, which it repairs), materializes the script into a content-addressed cache in the persistent `/workspace` volume, and runs it with the declared runtime. stdin always gets written-then-closed (`args.input` as JSON when present), argv/env/timeout are per-invocation, and large output offloads to the blobstore exactly like bash. Replaces hand-copied `/opt/*.cjs` scripts that were wiped on every container recreation.
- **`TOOL_CATALOG_REGISTER_SCRIPT` in the CLI** (`agentic-net-cli` — `roles.ts`, `tool-executor.ts`, regenerated `tools.generated.ts`), gated by the S flag (split out of D like the rest of the catalog tools) and picked up automatically by the MCP native layer. Tools guide documents the script workflow (`agentic-net-tools/README.md`).

### Changed
- **Executor large-output offload is now actually configured** (`deployment/docker-compose*.yml`). Every executor now sets `BLOBSTORE_HOST=http://sa-blobstore:8080`. Without it the executor's blob client fell back to `localhost:8095` (nothing in the container), so a command whose stdout/stderr exceeded the inline threshold (128 KB) was silently truncated to a preview instead of offloaded — unless the command token happened to carry `blobStore.host` itself.
- **Blob ids are explicitly CSPRNG-generated** (`sa-blobstore` — `BlobController`). The default `timestamp` strategy now emits `YYYY-MM-DD/<192-bit SecureRandom token>` instead of a UUID string; both it and the `uuid` strategy are backed by `java.security.SecureRandom`. Since the blobstore has no auth, a blob id is the access capability, so it must be unguessable; the `content-hash` strategy remains deterministic-by-content and is documented as unsuitable for confidential payloads.

### Fixed
- **Blob payloads survive container recreation** (`deployment/docker-compose.yml`, `docker-compose.hub-only.yml`, `docker-compose.hub-only.no-monitoring.yml`, `docker-compose.multi-master.yml`). `sa-blobstore` wrote its payloads to `STORAGE_PATH=/app/data` on the container's writable layer — nothing was mounted there — so every blob was destroyed whenever the container was recreated (`docker compose up -d` after an image bump, a `down`, a host restart). That silently broke the durable tool catalog, whose script artifacts and OpenAPI specs live in the blobstore and are referenced from catalog tokens by blob URN: the tokens survived, the payloads did not, and the digest check then refused to run the tool. Every compose file now mounts a named `blobstore-data` volume at `/app/data`.

### Security & operations
- **sa-blobstore deployment guidance** (`sa-blobstore/README.md`). Documented that the store has no built-in auth and relies on network isolation + unguessable ids; that any deployment reachable beyond a single trusted host **must** be fronted with HTTPS/TLS (and auth); and that `STORAGE_PATH` must be mounted to a persistent volume or blobs (including durable tool-catalog script artifacts) are lost on container recreation. Corrected the stale Docker example that mounted the wrong storage path.

## [2.23.0] - 2026-07-12

### Added
- **Tool-catalog tools in the CLI — and, through it, in chat and MCP** (`agentic-net-cli` — `roles.ts`, `tool-executor.ts`, `tools.generated.ts`). The four new `TOOL_CATALOG_*` tools (search, get, import-image, register-http) call the master's `/api/tool-catalog` surface and are gated by the same **D** (docker) flag as the rest of the container tooling. The MCP server's native layer picks them up automatically from the shared catalog, so an MCP-connected coding agent can now build a tool image on its own Docker host, `docker push` it to the bundled AgenticOS registry, and have AgenticOS validate, contract-check, and catalog it — without the master ever building an image. See `core/CHANGELOG.md` for the catalog itself.
- **"Durable Tool Catalog" section in the tools guide** (`agentic-net-tools/README.md`). Documents the build → push → `TOOL_CATALOG_IMPORT_IMAGE` workflow, the local-registry-only import rule, upsert-by-id semantics, and the run-time digest pinning that requires a re-pushed tag to be re-imported before it may run again.

### Changed
- **Dependency bumps** (dependabot sweep, no behavior changes). Maven: OpenTelemetry `sdk-testing` 1.64.0 (executor/gateway/blobstore, test-only), `spring-vault-core` 3.2.1 + `springdoc-openapi` 2.8.17 (vault), `hibernate-validator` 8.0.4.Final + `jakarta.validation-api` 3.1.1 (blobstore). npm (`agentic-net-cli`, bundled into chat/mcp): `@anthropic-ai/sdk` 0.111.0, `commander` 15, `ora` 9, `@types/node` 22.20.1, `yaml` 2.9.0, and `openai` 4 → 6 (one code change: the v6 `tool_calls` union needs a `type === 'function'` guard in the OpenAI provider). All four Java test suites, three TS builds/typechecks, and the MCP vitest suite green.

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

