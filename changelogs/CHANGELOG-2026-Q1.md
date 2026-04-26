# Release Notes — 2026 Q1 (Jan – Mar 2026)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Notes

This is the **launch quarter**. The first half (Jan – early Feb) was
pre-release development in the private `core/` repo; the **2026-02-22 repo
split** carved the open-source services (gateway, executor, vault, cli, chat,
blobstore) into this public `agentic-nets/` repo; and the first tagged
release `v1.2.0` shipped on 2026-03-01. Six versioned releases dated within
this quarter are listed below, originally introduced when the `CHANGELOG.md`
file was first added in `v1.19.0`.

## Pre-release development summary

Weekly bullets covering the work that led up to `v1.2.0`. All commits before
2026-02-22 happened in `core/`; from W08 onward the open-source services
also have history in `agentic-nets/`.

### Capacity gating, ArcQL interpolation, blob URNs (Dec 29 2025 – Jan 25)

- **W01 (Dec 29 – Jan 4).** **Pre-fire postset capacity gating** — capacity
  check before transition firing, documented. **Real-time SSE streaming for
  Universal Assistant agent events.** Mobile pinch-to-zoom from viewport
  center (no first-pinch jump), drag-vs-select swap.
- **W02 (Jan 5 – Jan 11).** **ArcQL interpolation support for preset
  dependencies.** MAP badge icon unified across icon packs. Logback
  configuration consolidated. Legacy tests removed from `flow-net-test-client`.
- **W03 (Jan 12 – Jan 18).** Meta-net token-structure documentation for
  agents. **Auto-parse JSON strings to arrays/objects in template
  expressions.** Batch-API race condition + 422 duplicate-name handling
  fix. File-only logging with 300 MB rolling, DEBUG noise reduced.
- **W04 (Jan 19 – Jan 25).** Builder-tab assistants get selected-element
  context. Sketch-folder references removed; workspace-nets paths
  normalized. Force-touch gesture + edit-element dialog dropped.
  **SA-BlobStore auto-ID endpoint + executor binary URN support** —
  paired with two blog articles documenting the BlobStore integration
  journey. Double-nested token-structure handling in command executor.

### Master proxy, role model, OAuth2 gateway (Jan 26 – Feb 15)

- **W05 (Jan 26 – Feb 1).** **Executor command-only architecture with
  master-centric orchestration.** Executor registry for dynamic discovery.
  **Master-proxy architecture for private node deployment.** Agent session
  with roles + structure-creation tools. **`FIRE_ONCE` tool** for
  autonomous agents. Role-based system prompts. Token-loss prevention when
  no emit rule matches. Comprehensive E2E test framework for transitions.
- **W06 (Feb 2 – Feb 8).** Agent-pipeline roles + GUI token tools.
  **`rwxh` permission model replaces named agent roles**, knowledge docs
  consolidated. **Unified Docker Compose deployment** for FlowOS first
  shipment.
- **W07 (Feb 9 – Feb 15).** **OAuth2 gateway architecture with JWT auth and
  single gateway URL.** Agent system enhanced with `llmCommand` bash
  routing + autonomous tools. Agent system prompts reduced ~65% to cut
  token usage. Agent stop button, `DELETE_NET` fix, compact assistant
  header. Master event-line framework + GUI editor + flowos startup
  script. **Rename `flow-net-agent` → `flow-net-gateway`** (the gateway
  pivot). Toolbar streamlining + 401 redirect.

### Tool ecosystem, Docker, repo split, v1.2.0 (Feb 16 – Mar 1)

- **W08 (Feb 16 – Feb 22).** **`EXTRACT_TOKEN_CONTENT` tool, Telegram bot,
  CLI improvements.** **`EXECUTE_TRANSITION` + `EXECUTE_TRANSITION_SMART`,
  runtime preflight, agent loop safety limits.** **`NET_DOCTOR`,
  `CREATE_RUNTIME_PLACE`, LLM transition execution.** **Docker tool
  registry, container lifecycle**, Tools sidebar panel for Docker registry
  + container management, six review findings fixed. **Containerize full
  stack with gateway-only host access** + Docker tool fixes. Multi-model
  executor support with upstream auth + discovery. Comprehensive
  documentation overhaul + GUI editor improvements. **Repo split on
  Feb 22** — `agentic-nets/` repository created from `core/`'s open-source
  services after deployment definition stabilized.
- **W09 (Feb 23 – Mar 1).** GUI updated to use vault credentials via
  gateway. **Monitoring moved from `core/` to `agentic-nets/`** as single
  source of truth. **`GET_PLACE_CONNECTIONS` tool** added to agent system.
  **`EXTRACT_RAW_DATA` tool** + `QUERY_TOKENS` auto-truncation removed.
  `agentic-net-wordpress` content rebrand + maintenance scripts.
  Universal Assistant analysis-first behavior + sidebar UX. LLM layouts.
  **`v1.2.0` released 2026-03-01** — first tagged release in both repos.

## Released versions

The six versioned `CHANGELOG.md` entries dated within Q1 2026 (originally
introduced when the CHANGELOG file was first added in `v1.19.0`).

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
