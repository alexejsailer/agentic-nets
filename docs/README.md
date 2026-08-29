# Agentic-Nets Documentation

This is the documentation map for Agentic-Nets. Choose the shortest path that
matches what you want to do; the root [README](../README.md) remains the product
overview and recommended first installation.

## Start here

| I want to… | Begin with |
|---|---|
| See Agentic-Nets without installing it | [Live systems](#live-systems) |
| Run it on one computer | [Desktop Lite](../agentic-net-desktop/DESKTOP-LITE.md) |
| Deploy it with Docker | [Docker deployment](../deployment/README.md) |
| Understand what it is | [Chapter 1: What Agentic-Nets Is](book/chapter-01-what-agentic-nets-is.md) |
| Learn the engineering discipline | [Chapter 2: Graph Engineering](book/chapter-02-graph-engineering.md) |
| Understand the services and runtime | [Architecture](../ARCHITECTURE.md) |
| Connect an AI or automation client | [MCP server](../agentic-net-mcp/README.md) |
| Build a custom application | [Net Application developer guide](applications/DEVELOPER_GUIDE.md) |

## Concepts and book

The [Agentic-Nets Book](book/README.md) explains the product model independently
of installation details:

1. **[What Agentic-Nets Is](book/chapter-01-what-agentic-nets-is.md)** — living
   processes, persistent state, runtime/model separation, applications,
   governance, event sourcing, and crystallization.
2. **[Graph Engineering](book/chapter-02-graph-engineering.md)** — how to design,
   operate, verify, and evolve the harness as an explicit live graph.

For the academic lineage from XML-Netze to the current runtime, read
[Foundations](../FOUNDATIONS.md). For the longer product argument and control
loop, read the
[Harness Control System whitepaper](whitepaper/the-harness-control-system.html)
or [open the rendered
version](https://raw.githack.com/alexejsailer/agentic-nets/main/docs/whitepaper/the-harness-control-system.html).

## Install and operate

- **[Desktop Lite](../agentic-net-desktop/DESKTOP-LITE.md)** — local package,
  first connection, bundled services, updates, data locations, and limitations.
- **[Docker deployment](../deployment/README.md)** — Compose profiles, providers,
  monitoring, tool images, health checks, and troubleshooting.
- **[Post-deployment configuration](../deployment/POST_DEPLOYMENT_CONFIG.md)** —
  configuration after the first server deployment.
- **[Public TLS deployment](../deployment/PUBLIC-TLS-DEPLOYMENT.md)** — exposing a
  server installation intentionally and safely.
- **[Multi-master architecture](../agentic-net-gateway/ARCHITECTURE-MULTI-MASTER.md)** —
  model routing across multiple masters.

## Build and integrate

- **[MCP server](../agentic-net-mcp/README.md)** — connect Codex, Claude Code,
  Claude Desktop, Cursor, or another MCP client.
- **[Net Application developer guide](applications/DEVELOPER_GUIDE.md)** — build
  a verified human interface over a live session runtime.
- **[Persona Kanban tutorial](applications/PERSONA_KANBAN_TUTORIAL.md)** — a full
  application example.
- **[Approval Room tutorial](applications/APPROVAL_ROOM_TUTORIAL.md)** — a human
  approval surface over governed process state.
- **[Application certification](applications/APPLICATION_CERTIFICATION.md)** —
  package and UI-surface verification requirements.
- **[CLI](../agentic-net-cli/README.md)** and
  **[chat integration](../agentic-net-chat/README.md)** — alternative clients.

## Runtime guides

- **[Observability](../agentic-net-mcp/src/knowledge/observability.md)** — retained
  causal events, transition history, token lineage, live cursors, and stated
  durability.
- **[Commands and executors](../agentic-net-mcp/src/knowledge/commands.md)** —
  controlled local or remote command execution.
- **[Tool catalog](../agentic-net-mcp/src/knowledge/tool-catalog.md)** — HTTP
  services, scripts, containers, and tool nets.
- **[Technical architecture](../ARCHITECTURE.md)** — coordination fabric,
  transition types, ArcQL, agent roles, shared places, executors, and
  persistence.
- **[Gateway](../agentic-net-gateway/README.md)**,
  **[executor](../agentic-net-executor/README.md)**,
  **[Vault](../agentic-net-vault/README.md)**, and
  **[blob store](../sa-blobstore/README.md)** — component references.

## Live systems

### One-click read-only nets

- [Hardened Lane](https://agentic-nets.com/#/shared-net/bd685551-ed9b-48ff-bf0c-6c32520d6f68) —
  validation, bounded AI work, QA, rework, human escape, deployment, and
  verification.
- [Token Flow Basics](https://agentic-nets.com/#/shared-net/f2663810-bcce-4ed2-9507-40f77b3be04c) —
  the smallest useful net.
- [Seven Transition Types](https://agentic-nets.com/#/shared-net/c1b98b10-c521-4b33-9318-7e68114fa3ec) —
  deterministic and intelligent execution mechanisms together.
- [Crystallization](https://agentic-nets.com/#/shared-net/c989eac2-b6ef-4b35-a107-6ac3ef26d469) —
  AI-assisted discovery becoming deterministic structure.

### Safe Team monitor

The public monitor exposes the live `safe-teams` model without write access:

1. Open [agentic-nets.com/#/monitor](https://agentic-nets.com/#/monitor).
2. Paste the public read-only token:

   ```text
   07a9af1d663f899f79f08ca56050a977d41472e34cc0dd0f74abe046446f78f9
   ```

3. Keep **Read-only access (no writes)** enabled.

Guests can inspect live nets, token counts, event stories, agendas, and current
handoffs. They cannot edit, deploy, fire transitions, or invoke write-capable
personas.

### Running products and videos

- [Agentic-Nets forum](https://forum.agentic-nets.com) — feature requests can be
  handled by the Safe Team process, with lifecycle updates posted to the thread.
- [Git Analytics](https://gitanalytics.agentic-nets.com) — a product maintained
  through that delivery process.
- [8-minute guided tour](https://youtu.be/hgW11A_7vWY) — from login to a running
  multi-agent team.
- [Safe Product Team Studio tour](https://www.youtube.com/watch?v=VBomzW-xqfc&list=PLQirdTX_nt94) —
  a real change moving through the engineering team.
- [Long-form developer introduction](https://www.youtube.com/watch?v=VWm4OCwWnZM) —
  the runtime, control plane, NetHub, and Safe Team in depth.

## Project and community

- [Latest release](https://github.com/alexejsailer/agentic-nets/releases/latest)
- [Changelog](../CHANGELOG.md)
- [Security policy](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
- [GitHub Discussions](https://github.com/alexejsailer/agentic-nets/discussions)
- [Community forum](https://forum.agentic-nets.com)
