# Release Notes Archive

The active `CHANGELOG.md` at the repo root only contains the **current
calendar quarter's** releases. When a quarter ends, its entries are moved
into a per-quarter file in this folder.

| Quarter | File | Coverage |
|---|---|---|
| 2026 Q2 | [CHANGELOG-2026-Q2.md](CHANGELOG-2026-Q2.md) | `v2.1.2` → `v2.16.0` — OAuth2 gateway + vault credential flow maturation, tool-net library + Forge (pre-wired scaffolds, concurrency isolation), agent capability flags (`T`/`C`), default model → `glm-5.2:cloud` |
| 2026 Q1 | [CHANGELOG-2026-Q1.md](CHANGELOG-2026-Q1.md) | First releases (`v1.6.0` → `v1.19.0`), 2026-02-22 repo split, `v1.2.0` launch tag, pre-release dev summary Jan – Feb |
| 2025 Q4 | [CHANGELOG-2025-Q4.md](CHANGELOG-2025-Q4.md) | Pre-release dev — distributed execution engine, agent transitions, outbound-only architecture, designtime API, conditional emit |
| 2025 Q3 | [CHANGELOG-2025-Q3.md](CHANGELOG-2025-Q3.md) | Pre-release dev — project foundations, multi-model architecture, NL→PNML, GUI editor, IR self-consistency |

Pre-release entries (anything before `v1.2.0` on 2026-03-01) summarize work
that originally lived in the private `core/` monorepo. The open-source
services were carved out of `core/` on 2026-02-22, so they share that
upstream history.

## Rotation rule

When the current calendar quarter ends, move all dated entries from the
root `CHANGELOG.md` into a new `CHANGELOG-YYYY-Qn.md` here, leave the
`## [Unreleased]` section behind, and add a row to the table above. The
[root README](../README.md#release-notes) links to this folder.
