---
name: agenticos-control
description: This skill should be used when the user asks to design persona agents or specialist teams, attach context playbooks, inspect, operate, diagnose, or author Agentic-Nets on an AgenticOS / AgenticNetOS stack. Triggers include creating a developer/coach/domain agent, listing nets/sessions/transitions, reading or editing places and tokens, calling designtime/runtime APIs, firing or diagnosing a transition, doing token surgery, driving Universal Assistant / Persona / Forge, running a tool-net, or exporting a net diagram. Works CLI-first (the `agenticos` binary) with a curl fallback in direct or gateway (OAuth2) mode.
---

# Controlling AgenticOS / AgenticNetOS

AgenticNetOS runs real operations on **Agentic-Nets**: Petri nets (places, transitions, arcs, tokens) where
transitions come in seven kinds (pass, map, http, llm, agent, command, link). Two layers matter:

- **PNML (design-time)** = what a net looks like: places, transitions, arcs, x/y. Authored via the
  `/api/designtime` API. Does NOT hold execution config.
- **Inscription (run-time)** = how a transition executes: ArcQL binding, action, emit rules. Stored per
  transition. Authored via `POST /api/transitions/assign` (see the footgun below).

## Prefer persona-first designs

Translate judgment-heavy goals into a named specialist or small team before exposing workflow
mechanics. Define each charter, inbox/outbox, context, boundaries, and review hand-off; keep routing
deterministic. Select the brain explicitly: server provider for ordinary agent/llm lanes; an agent
with `llmMode:"bash"` + `binary:"claude"|"codex"` for an unattended CLI-backed persona when no
server provider exists; a command lane for one-shot headless work; connected execution otherwise.
Say whether it runs while disconnected. Use context nets plus non-firing typed link transitions as
reusable domain playbooks. Read `references/personas.md` when creating or installing a persona/team.

Everything is event-sourced in the **node** (:8080); the **master** (:8082) orchestrates and exposes the
control APIs; the **gateway** (:8083) fronts both with OAuth2 for remote access.

## How to talk to a stack (do this first)

All control goes through one dispatcher: **`${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/anos.sh`**.
It is CLI-first (uses the `agenticos` binary when present) with a curl fallback, and auto-detects auth.

1. Run **`bash "$SD/anos.sh" preflight`** (where `SD=${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts`)
   to see the resolved mode/auth/targets and reachability. It never prints secrets.
2. Set the target with environment variables (details in `references/auth.md`):
   - **Direct** (local dev, no auth): `AGENTICOS_MASTER=http://localhost:8082` `AGENTICOS_NODE=http://localhost:8080` (defaults).
   - **Gateway** (remote/prod): `AGENTICOS_GATEWAY_URL=http://host:8083` plus `AGENTICOS_ADMIN_SECRET=...`
     (or `AGENTICOS_GATEWAY_SECRET_FILE=/path/to/admin-secret`). Auth auto-selects gateway when a secret is present.
3. Raw calls when a script does not cover it: `anos.sh master GET '/api/...'` / `anos.sh master POST '/api/...' '<json>'`,
   `anos.sh arcql <modelId> '<ARCQL>'`, `anos.sh events <modelId> '<events-json>'`, `anos.sh cli <args>`.

## Task -> script map

Prefer these ready-made scripts (all under `scripts/`, all source `anos.sh`):

| Goal | Script |
|------|--------|
| Snapshot a model: transitions + states + schedules; a session's nets; a net's places/tokens | `net-inspect.sh <modelId> [sessionId] [netId]` |
| Read / add / delete tokens in a place (token surgery) | `place-tokens.sh <get\|count\|post\|delete> <modelId> <place> [data\|tokenId]` |
| Fire a transition once (handles the 409-while-running case) | `fire-transition.sh <modelId> <transitionId>` |
| Diagnose a transition (state + error + recent events) | `diagnose.sh <modelId> <transitionId>` |
| Drive a persona (Universal Assistant / Persona / operator / any id) | `drive-persona.sh <persona> <modelId> "<prompt>"` |
| Run Forge (build a tool-net from intent) | `forge-run.sh <modelId> "<intent>"` |
| Export a net (JSON or PNML XML) to a file | `export-pnml.sh <modelId> <sessionId> <netId> [outPath] [--xml]` |

For **structural authoring** (create/modify places, transitions, arcs, inscriptions, layout) delegate to the
bundled **`agenticos-net-designer`** agent. For **diagnosis/recovery of a running net** (stuck tokens, error
states, runaway loops) delegate to the **`agenticos-net-operator`** agent. Both know the engine deeply and use
these same scripts.

## Footguns that bite (honor these, do not just document them)

- **Set inscriptions with `POST /api/transitions/assign` only.** `POST /api/runtime/transitions` clears the
  value. (`references/transition-templates.md`.)
- **Runtime places are `createNode`, not `createLeaf`.** Token surgery deletes use a `deleteLeaf` event with a
  non-blank `name` + `parentId` (`references/recipes.md`).
- **Agent transitions:** set `autoEmit:false` and a long `reservationTtlMs` (e.g. 600000), or they double-fire.
- **`fireOnce` returns 409 while a transition is RUNNING.** Do STOP -> fireOnce -> START (`fire-transition.sh` does this).
- **Capacity gate defaults to 50** (some nets use 1). A transition silently stops firing when its target place is full; drain it or raise capacity.
- **ArcQL:** double `==`, double-quoted strings, and a bare `$.field` is a parse error; use `FROM $ WHERE $.status=="active"` or `$.field!=""`. (`references/arcql.md`.)
- **Secrets:** read from env / `*_FILE` only; never echo the admin secret or a JWT; never write them to disk.

## References (load on demand)

- `references/rest-api.md` — master + node endpoint families (method, path, minimal shapes).
- `references/capability-model.md` — the `rwxhludct` flags and the agent-tool groups.
- `references/personas.md` — persona/team design, execution backends, contexts, learning loop, and built-in personas.
- `references/arcql.md` — ArcQL grammar + gotchas.
- `references/transition-templates.md` — the 7 transition kinds + inscription templates + the assign contract.
- `references/auth.md` — direct vs gateway, the full env-var table, secret hygiene.
- `references/recipes.md` — copy-paste end-to-end flows (inspect, token surgery, fire+diagnose, drive persona, Forge).
- `references/diagram-export.md` — export a net and render it to a dark SVG/PNG diagram.
