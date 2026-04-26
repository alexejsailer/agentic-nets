# Release Notes — 2025 Q3 (Jul – Sep 2025)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Notes

These changes happened in the private `core/` repo before the 2026-02-22 split,
when AgenticNetOS was still a single monorepo and the project was internally
called *FlowOS*. The open-source services later carved out into this repo
(gateway, executor, vault, cli, chat, blobstore) share this history.

This quarter has no semver releases yet — the first tagged release is `v1.2.0`
on 2026-03-01. Three pre-release tags exist in `core/`: `single-model-v0`
(2025-08-20), `solid-ui-v1` (2025-09-14), and `fos-v1` (2025-09-18).

## Pre-release development summary

Weekly bullets, oldest week first. Each bullet summarizes the dominant theme
of the week's commits in `core/`.

### Foundations (Jul 14 – Aug 17)

- **W29 (Jul 14 – Jul 20).** Project scaffolded — initial directory structure,
  scheduler skeleton, basic build setup.
- **W30 (Jul 21 – Jul 27).** Candidate-set engine introduced — the
  bucket-based foundation that later becomes the Petri-net binding engine.
- **W31 (Jul 28 – Aug 3).** Engine internals — transaction-finalization
  groundwork.
- **W32 (Aug 4 – Aug 10).** First read-side projection of the engine state
  lands. Comprehensive engine + fuzz tests added. OpenTelemetry dependency
  wired in along with a REST client for talking to engine services.
- **W33 (Aug 11 – Aug 17).** OTel + Tempo end-to-end tracing operational.
  Further read-projection polish.

### Multi-model architecture, GUI, blobstore (Aug 18 – Aug 31)

- **W34 (Aug 18 – Aug 24).** **Multi-model architecture lands** with full
  event sourcing (tag `single-model-v0` 2025-08-20). JSON REST API + tests,
  configurable transaction grouping, in-memory snapshots + persistence,
  duplicate-name validation, sa-blobstore initialized, sa-consensus running,
  Petri-net editor experimentation begins (theming, edges, minimap, undo
  for drag).
- **W35 (Aug 25 – Aug 31).** Subnets in flow editor, multi-model API,
  PNML serialization, NL→PNML orchestration, NL panel + composer, multi-LLM
  provider support (Claude + Ollama), category-based context distillation,
  blobstore + test-client deployment configuration, OTel/Grafana fixes.

### NL→PNML, dark theme, IR, self-consistency (Sep 1 – Sep 21)

- **W36 (Sep 1 – Sep 7).** GUI modernization, message threading + refinement,
  PNML refinement learning, layout polish, Java program generation, transaction
  grouping serialization fixes, default LLM model swap to deepseek-r1-8b,
  concurrency hardening, integration tests.
- **W37 (Sep 8 – Sep 14).** Petri editor (accordion/canvas/minimap/dark theme/
  drag-drop/command palette/notification toast), variant generation +
  comparison, NL feature docs + LLM health monitoring, Playwright test
  framework, multi-model handling, IrService self-consistency validation
  (tag `solid-ui-v1` 2025-09-14).
- **W38 (Sep 15 – Sep 21).** Self-consistency toggle, structural fast-path
  routing for chat, chat MVP, variant-generation PNML wrapping fix
  (tag `fos-v1` 2025-09-18), maximize/minimize/restore with layout memory.

### IR refactor, mobile inspector (Sep 22 – Sep 30)

- **W39 (Sep 22 – Sep 28).** IR-based self-consistency refactor, ChatBot
  testing console, FlowOS credential management + validation.
- **W40 partial (Sep 29 – Sep 30).** Mobile inspector panel + chat, pinch
  zoom stabilization, compact view mode, properties panel sync.
