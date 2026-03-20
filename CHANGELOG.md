# Changelog

All notable changes to the AgenticOS open-source services are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.19.0] - 2026-03-23

### Added
- **Persona framework**: Pluggable assistant personas (builder, observer, analyzer, debugger) with role-based tool filtering
- **OBSERVE_MODEL tool**: Whole-model runtime snapshots for monitoring and debugging
- **GUI persona selector**: Dropdown in universal assistant editor to switch between personas
- **Version-pinned compose files**: All image tags use `AGENTICOS_VERSION` env var (no more `latest` drift)
- **Automated version pinning**: Jenkins prepare-release pipeline now updates compose file versions
- **CHANGELOG.md**: This file

### Changed
- Compose files now use `${AGENTICOS_VERSION:-1.19.0}` instead of hardcoded `1.2.0` or `latest`
- `.env.template` includes `AGENTICOS_VERSION` variable

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
