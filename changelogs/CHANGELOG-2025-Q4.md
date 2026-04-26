# Release Notes — 2025 Q4 (Oct – Dec 2025)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Notes

These changes happened in the private `core/` repo before the 2026-02-22 split.
The open-source services later carved out into this repo (gateway, executor,
vault, cli, chat, blobstore) share this history.

No semver releases yet — the first tagged release is `v1.2.0` on 2026-03-01.

## Pre-release development summary

Weekly bullets, oldest week first.

### Distributed execution + unified assistants (Oct 1 – Oct 19)

- **W40 (Sep 29 – Oct 5).** **Distributed Petri-net execution engine with
  master-side orchestration.** ArcQL place navigation, host-format parsing
  (`modelId@host:port`), single-node execution test + comprehensive guide,
  CAS validation simplification, write-locks for `ModelMediator` state
  updates.
- **W41 (Oct 6 – Oct 12).** **Unified assistant architecture** for ArcQL,
  Inscription, and Petri-net chat. Mobile chat container, Monaco editor +
  custom webpack, theme switching with multi-fallback detection,
  WorkspaceContextService for global state, comprehensive validation error
  messages for `TransitionInscription`, quick-start scripts, `applyDraft()`
  across all three assistants.
- **W42 (Oct 13 – Oct 19).** Inscription editor with chat + tabbed
  interface, duplicate-name validation in event processing,
  `PetriAgentService` + `PetriAgentCommandRecord`, chat mode toggle.
  Heavy mobile-touch work: swipe gestures with dedicated handle, touch-drag
  for drawing connections, context-menu lifecycle + finger-anchored
  positioning, multi-select viewport-jump fix, ripple-effect stabilization.
  Mobile-touch-interaction patterns documented in CLAUDE.md.

### FlowNet Agent, AGENT action, Command Agent (Oct 20 – Nov 9)

- **W43 (Oct 20 – Oct 26).** FlowNet Agent introduced. Petri-net execution +
  session management enhanced. New service to manage editors in GUI.
  Storage refactoring preparation.
- **W44 (Oct 27 – Nov 2).** **Command Agent activeEditorId tracking** wired
  end-to-end (mobile-aware change detection, focused-editor versioning,
  real-time PNML context). **AGENT action type** lands with comprehensive
  testing. Token explorer, clipboard for nodes/edges, sidebar collapse with
  local-storage persistence, horizontal single-mode editor layout, per-editor
  auto-refresh of token counts, mobile pan/zoom polish, fit-to-view on PNML
  load.
- **W45 (Nov 3 – Nov 9).** **Per-element version tracking** with
  `expectedVersion` propagation through the command layer and 409-CONFLICT
  handling in GUI; nine-phase rollout completed in a single week.
  **FlowOS Executor Agent** introduced. Auto-detect / auto-configure browser
  IP for mobile reachability. Metadata-contamination fix for workspace-net
  merge bug. FlowOS architecture docs expanded.

### Outbound-only architecture, executor refactor, designtime (Nov 10 – Dec 7)

- **W46 (Nov 10 – Nov 16).** **Outbound-only architecture** lands:
  `MasterPollingService`, `MasterTokenClient`, master orchestration REST
  APIs, master token streaming + reservation + release, enhanced executor
  polling endpoint with lifecycle commands. Comprehensive E2E test for the
  master-executor workflow. Centralized LLM integration through master
  delegation. ArcQL parentId context resolution + properties persistence
  fixes. WireMock-based LLM delegation testing infrastructure.
- **W47 (Nov 17 – Nov 23).** **Huge architecture refactor for master and
  executor** — executor now polls master in HYBRID mode over WebSocket.
  `flow-net-gmail-service` (OAuth2 Gmail REST). Token workbench table view,
  dark/bright theme across application, properties UI updates,
  inscription-by-example documentation.
- **W48 (Nov 24 – Nov 30).** **Designtime API + Runtime API** for visual
  Petri-net construction. Agent transition work continued. Save / header /
  Universal Assistant polish. `.mcp.json` moved to `.claude/`. Documentation
  reorganized into `docs/` hierarchy. `llm` action kind added.
- **W49 (Dec 1 – Dec 7).** **Autonomous agent session architecture** with
  `fireOnce` capability lands. Transition icons added (HTTP, etc.), all
  action kinds tested action-by-action.

### Conditional emit, agent transitions, persistence (Dec 8 – Dec 28)

- **W50 (Dec 8 – Dec 14).** **Conditional emit routing with take-mode
  support.** Agent transition execution + polling improvements. Tool-based
  execution infrastructure for Universal Assistant (replaces plan/actions
  format). Mobile clipboard via `touchend`, Monaco scroll-lock toggle,
  copy-paste of nodes, presetPlaces / postsetPlaces context for inscription
  assistant.
- **W51 (Dec 15 – Dec 21).** Node persistence added. Executor polish.
  Workspace-net sync refinement, PNML / description / label storage rework,
  Stored Editors panel shows actual net label. Verbose console logging
  cleaned up. Sidebar rounded borders, preview-card overflow fixes.
- **W52 (Dec 22 – Dec 28).** **Credential decryption + passing to action
  handlers.** Agent registration mechanism added (old agents removed).
  **Agent execution with token binding + template engine improvements.**
  Workspace-net sync metadata stabilization, model-setup + PNML-preview
  parsing guards, viewport-listener tightening, debug-flag-gated console
  logging.
