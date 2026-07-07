# Personas

Personas are pre-configured in-net agents (a role + knowledge + identity prompt). They are driven over SSE and
can be invoked agent-to-agent. Drive one with `scripts/drive-persona.sh <persona> <modelId> "<prompt>"`, or via
`GET /api/assistant/p/personas` then the chat/agent-stream endpoints in `rest-api.md`.

## Built-in personas

| id | display name | role | what it does |
|----|--------------|------|--------------|
| `assistant` (aliases: `universal`, `coordinator`) | Universal Assistant | `rwxhludct` | The single front door. Answers, acts, or delegates to any specialist. Driven at `/api/assistant/universal/{modelId}/...`. |
| `builder` (alias `designtime`) | Workflow Builder | `rwxhl-d-t` | Designs/constructs nets: places, transitions, arcs, inscriptions, deploy. Builds + uses tool-nets. |
| `operator` (aliases `observer`, `analyzer`, `debugger`) | Net Operator | `rwx-l-dct` | Diagnose/fix running nets (Observe -> Diagnose -> Fix -> Verify). Cannot create/delete nets. |
| `persona` | Persona | `rwxhludct` | Meta-agent: talks to the user, then builds/deploys/starts a personal Agentic-Net and remembers it (`p-persona-*`). |
| `chronicle` | Session Chronicle | `rw---` | Records/analyzes/reports over time; writes only under `/chronicle/`. |
| `domain-expert` | Domain Expert | `rwxh-` | Per-model memory layer; fills 5 domain places, routes questions. |
| `domain-expert-readonly` | Domain Expert (read-only) | `r--hl` | Monitoring guest; its only side effect is filing a feature request token. |

Personas with `{personaId}` are driven at `/api/assistant/p/{personaId}/{modelId}/...`; the Universal Assistant
also has the dedicated `/api/assistant/universal/{modelId}/...` surface. Aliases resolve to the canonical id.

## Forge (the tool-builder)

**Forge** is a tool-builder meta-agent exposed as an async API rather than a chat persona:
- `POST /api/forge/{modelId}/runs` with `{prompt}` enqueues a build; returns `{requestId, status:"queued"}`.
- `GET /api/forge/{modelId}/runs` collapses the run feed to `queued -> running -> done|failed`.
Use `scripts/forge-run.sh <modelId> "<intent>"` — it starts the run and polls to completion. Forge designs,
scaffolds, and smoke-tests a **tool-net** (a reusable capability net) from a natural-language intent.

## Invocation paths (for reference)

1. **Interactive SSE** (what the scripts use): `chat/start` -> `chat/{conversationId}/agent-stream`.
2. **Agent-to-agent**: an in-net coordinator with the **c** flag calls `INVOKE_PERSONA` / `DELEGATE_TASK` and
   gathers results with `COLLECT_RESULTS`. Delegated children have `INVOKE_PERSONA` stripped (no recursive spawning).
3. **One tool, no loop**: `POST /api/assistant/universal/{modelId}/tools/{toolName}/execute`.

Persona and the domain-expert personas auto-bootstrap a small memory skeleton (`p-persona-*`,
`p-{modelId}-domain-*`) on first `chat/start`.
