# Changelog

All notable changes to the AgenticNets open-source services are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Automated version pinning**: Jenkins prepare-release pipeline now updates compose file versions
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

## [1.14.0] - 2026-03-07

### Changed
- Release with accumulated improvements

## [1.13.0] - 2026-03-04

### Changed
- Release with accumulated improvements

## [1.11.0] - 2026-02-28

### Changed
- Release with accumulated improvements

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
