# Changelog

All notable changes to the AgenticNets open-source services are documented here.

This file holds only the **current calendar quarter's** releases. Older
quarters are archived under [`changelogs/`](changelogs/) — see
[`changelogs/README.md`](changelogs/README.md) for the index. At the end of
each quarter, the entries below get moved into a new `changelogs/CHANGELOG-YYYY-Qn.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.17.0] - 2026-07-03

### Added
- **agenticos-control Claude Code plugin** (`claude-plugin/agenticos-control/`, `.claude-plugin/marketplace.json`). Drive a running AgenticNetOS stack from Claude Code: two agents (net designer, net operator), six slash commands (`/agenticos-inspect`, `-doctor`, `-fire`, `-persona`, `-forge`, `-export`), a skill with eight reference docs, and a CLI-first/curl-fallback dispatcher supporting gateway OAuth2 or direct auth (secrets from env/file only, never printed). Install: `/plugin marketplace add alexejsailer/agentic-nets` → `/plugin install agenticos-control@agentic-nets`.
- **Thinking-model configuration pass-through** (`deployment/` — `docker-compose.yml`, `docker-compose.hub-only.yml`, `.env.template`). New optional `OLLAMA_THINKING_MODEL` / `CLAUDE_THINKING_MODEL` keys reach `agentic-net-master` and enable its new dynamic post-THINK model routing for agent sessions (see `core/CHANGELOG.md`). Blank (the default) leaves routing off.

### Changed
- **Test hardening** (`agentic-net-executor`, `agentic-net-gateway`, `agentic-net-vault`, `sa-blobstore`). +218 hermetic tests for previously zero-coverage features (command dispatch, credentials cipher, token rate limiting, JWT/admin-secret bootstrap, two-phase upload durability, cluster health, and more). No wire-format or configuration changes.

