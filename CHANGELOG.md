# Changelog

All notable changes to the AgenticNets open-source services are documented here.

This file holds only the **current calendar quarter's** releases. Older
quarters are archived under [`changelogs/`](changelogs/) — see
[`changelogs/README.md`](changelogs/README.md) for the index. At the end of
each quarter, the entries below get moved into a new `changelogs/CHANGELOG-YYYY-Qn.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

