# AgenticNets — Architecture

A one-page deep dive into the coordination fabric, the seven transition types, the query language, and how multiple agents share state.

---

## 1. The coordination fabric

Agents in AgenticNets don't call each other. They **drop structured JSON tokens into shared places** and let *transitions* react. A place is a typed slot in an event-sourced tree; a token is a JSON leaf with metadata (id, parent, timestamps, provenance). A transition is a small program with **presets** (places it reads from), **postsets** (places it writes to), an **action** (what it does), and an **emit** rule (where results go).

```
  [p-intake]  ──►  ( t-triage )  ──►  [p-work]  ──►  ( t-agent )  ──►  [p-done]
                                          │
                                          ▼
                                     [p-memory]   ◄──  read by future turns
```

This is a Petri-net at heart, extended with seven concrete transition kinds so you don't have to write executable glue.

---

## 2. The seven transition types

| Kind | Where it runs | What it does |
|---|---|---|
| `pass` | master | Pure routing — move tokens between places with optional `when` filtering. |
| `map` | master | Template transformation (`${input.data.field}`), no side effects. |
| `http` | master | External API call with retry, auth, correlation-id, idempotency cache. |
| `llm` | master | Single-shot LLM inference, response parsed into emit targets. |
| `agent` | master | Autonomous multi-step agent loop (rwxhl tool surface). |
| `command` | executor (8084) | Shell/filesystem via `ProcessBuilder("bash", "-c", …)`. |
| `link` | master | Knowledge-graph edges between places (for navigation / lineage). |

**Deterministic lane** (pass/map/http/link) runs without LLM cost.
**AI lane** (llm/agent) is where reasoning happens.
**Execution lane** (command) is offloaded to a pull-polling executor.

**Key design property — crystallization.** Teams start with `agent` transitions to explore a problem, then harvest the working recipe into deterministic transitions. The net's AI spend shrinks as the net matures.

---

## 3. ArcQL — selecting tokens from places

Presets select tokens with a small query language:

```
FROM $ WHERE $.status == "active" LIMIT 1
FROM $ WHERE $.priority == "high" ORDER BY $.createdAt DESC
FROM $                                                      -- all tokens
```

- Paths start with `$` (`$.foo.bar`).
- Equality is `==` (not `=`), strings are double-quoted.
- Reservation-aware: in-flight tokens are invisible to other transitions during a fire.

---

## 4. Agent transitions — roles and tools

Every agent transition declares a role from the `rwxhl` flag alphabet:

| Flag | Power |
|---|---|
| `r` | Read — query tokens, inspect places/transitions |
| `w` | Write — create/delete tokens, places, nets, inscriptions |
| `x` | Execute — deploy/start/stop/fire transitions, Docker, packages |
| `h` | HTTP — direct HTTP calls from inside the agent (skips http transitions) |
| `l` | Logs — query the in-memory event line for observability |

The tool catalog is the single source of truth — the CLI regenerates its schema from it via `npm run sync-tools`, so the in-net agent and the CLI agent always share the same surface.

**Two-tier LLM config (per agent transition).** Every agent inscription can declare a cheap `toolsModel` and a stronger `thinkingModel`, with `activeTier` picking which one hot fires use. Switching is between-fires only: `SET_INSCRIPTION({ action: { activeTier: "thinking" } })` takes effect on the next fire. Works for both API mode (using master's global `LlmService`) and bash mode (`claude -p` or `codex exec`).

---

## 5. Multi-agent coordination via shared places

Multiple agents coordinate by **sharing a place**, not by calling each other:

```
  Agent A                       Agent B
     │                             │
     │   writes {req-id: 42}       │
     └─────────────►  [p-shared]  ─┴──► reads {req-id: 42}
```

- **No direct invocation** — any agent (or deterministic transition) that declares `p-shared` as a preset can pick up the token.
- **Correlation-id propagation** — the `_meta.correlationId` field is preserved across transition boundaries so request/response pairs can rendezvous.
- **Capacity gating** — postsets can declare `capacity: N` so upstream transitions back-pressure instead of flooding.

This makes composing autonomous specialists (PM / architect / developer / QA / DevOps) into a team a matter of sketching places and arcs, not writing orchestration code.

---

## 6. Tool-net marketplace

Capabilities can be packaged as their own nets and published to a registry. A manifest leaf declares the net's trigger place, result place, and correlation field; any agent can:

| Tool | Purpose |
|---|---|
| `LIST_TOOL_NETS` | Discover available tools |
| `DESCRIBE_TOOL_NET` | Read the manifest |
| `REGISTER_TOOL_NET` | Publish a net as a tool |
| `INVOKE_TOOL_NET` | Synchronous, correlation-id-matched call |
| `SCAFFOLD_TOOL_NET` | Auto-build a new tool skeleton |

Tool sessions can be tagged (e.g. `tools`) so `LIST_SESSIONS_BY_TAG` pulls the whole catalog. An agent can both **use** tool-nets and **create new ones** — the marketplace compounds.

---

## 7. Pull-polling executor model

The executor never receives inbound traffic. It **polls** the master (or the gateway) every 2 s, fetches assigned transitions with bound tokens, executes them, reports results. This has three consequences:

- **Firewall-friendly.** Egress-only connections cross any NAT.
- **Horizontally scalable.** Add executors, master assigns more transitions — no coordination protocol needed.
- **Stateless master.** All state lives in node (event-sourced), so master can be restarted freely.

```
  executor  ─GET  /api/transitions/poll─►  master  ─ArcQL─►  node
            ◄─bound tokens + FIRE cmd─
            ─POST /api/transitions/:id/deployment─►  master
```

---

## 8. GUI, observability, persistence

- **Workspace graph editor**: nets as nodes, shared places / link transitions as edges; ELK auto-layout, persisted per-user positions.
- **Token workbench**: blob URN preview, token drill-down, inscription editor with Monaco.
- **OTel everywhere**: Grafana dashboards + Prometheus + Tempo via `monitoring/`.
- **Event-sourced persistence**: immutable append-only events, CQRS read models, deterministic replay.

---

## 9. Where to go next

| If you want to… | Read |
|---|---|
| Try it locally | [README.md](README.md) |
| See what moved last cycle | [CHANGELOG.md](CHANGELOG.md) |
| Contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Use the CLI | [agentic-net-cli/README.md](agentic-net-cli/README.md) |
| Deploy the stack | [deployment/README.md](deployment/README.md) |

Closed-source core services (node, master, gui) ship as signed Docker Hub images under `PROPRIETARY-EULA.md`; open-source services in this repo are under `LICENSE.md` (BSL 1.1, converts to Apache 2.0 on 2030-02-22).
