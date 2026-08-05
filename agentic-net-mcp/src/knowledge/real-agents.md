# Real agents: personas scheduled on Petri nets

A "real agent" here is not a chat loop — it is a NET. The persona lives in a charter place, work
arrives as tokens in an inbox place, a schedule makes it act unattended, context is places (and
linked places / context nets), every reasoning step is one bounded, auditable fire, and results
land in output places other nets can consume. `spawn_persona` builds this shape in one call; this
doc is for composing it deliberately — and for choosing HOW the reasoning step executes.

## The five ways a reasoning step can execute

| Path | Runs on | Unattended? | Needs |
|---|---|---|---|
| llm/agent lane | master | yes | healthy server LLM provider (llm_health READY/ONLINE) |
| agent lane with llmMode:bash | master | yes | Claude Code or Codex installed beside master |
| command lane → headless CLI | executor host | yes | Claude Code or Codex installed on that host |
| external fire (prepare→complete) | YOU, the connected client | no | nothing extra |
| host_transition | the MCP process | while connected | a provider on the MCP side |

Choosing: provider healthy (READY/ONLINE) → llm/agent lanes (master owns the schedule, retries, error emits, cost
metering). Provider DISABLED (the Desktop Lite default) → prefer a CLI-backed agent lane for a
persona because it preserves the bounded agent loop, capabilities, tools, context, and auto-emit.
Use a command lane for a one-shot stdin→stdout headless job; external fires cover the attended rest.
With these patterns a provider-less deployment still fetches, computes, and reasons unattended.

## Headless Claude Code or Codex: pipe the prompt via stdin

    printf '%s' '<prompt>' | claude -p --model sonnet --allowedTools 'Read,Grep' --no-session-persistence
    printf '%s' '<prompt>' | codex exec --ephemeral --sandbox read-only -

NEVER pass the prompt as a quoted `-p "<prompt>"` argument: between token → executor spawn →
shell, nested quotes can be consumed (proven on Windows) — claude then starts with NO prompt,
waits ~3s for stdin, and answers at its own discretion. The pipe removes nested quoting entirely
and supplies stdin, so nothing hangs. Long or dynamic prompts: have a script print them —
`python build_prompt.py | claude -p --model sonnet`. Chain deterministically the same way:
`... | claude -p --model sonnet | python send_report.py`.

For an agent lane, set `action.llmMode:"bash"` and `action.binary:"claude"|"codex"`; master builds
the safe stdin invocation and keeps the complete agent session around it. For a command lane, the
examples above are the command. Flags for unattended spawns: explicit model when needed; least-
privilege — omit tools entirely for text-only tasks; `--no-session-persistence`; `args.timeoutMs`
in MINUTES, not seconds (a cold CLI start plus one API round trip is easily 10-30s).

## Context: workingDir is the context switch

Headless Claude auto-loads the CLAUDE.md/memory of the project `args.workingDir` points into —
full domain context with zero prompt engineering. That is the feature AND the hazard: an
unattended instance with tools plus rich context is a sharp instrument, so keep the tool surface
minimal and point workingDir only where the agent belongs. Net-side context lives in places: a
charter/config place the prompt-builder map interpolates, linked places (memory_link,
GET_LINKED_PLACES), or an installed context net (ATTACH_CONTEXT).

## The agent shape, by hand

- `p-<name>-charter` — persona + standing instructions (a config token templates interpolate)
- `p-<name>-task` — the inbox; you, schedules, or OTHER nets write work here
- the reasoning lane — one of the four paths, consuming the inbox. For headless Claude: a map
  lane builds the CommandToken (prompt piped via stdin inside `args.command`) → command lane →
  result place (`docs/commands` for the token schema and the `batchResults` result shape)
- `p-<name>-output` — results; downstream lanes or other agents consume them; `protocol_write`
  journals milestones

Schedule the producer map (6-field cron, `onEmpty: fire` for self-initiating heartbeats) and the
agent acts alone — always tell the user what you armed. Multi-agent systems are nets sharing
places: one agent's output place is another's inbox. Deterministic chaining beats an orchestrator
poll-loop (docs/recipes).

## Security and cost

- Secrets NEVER inline in tokens or `args` (places are event-sourced — a pasted secret is
  permanent): `set_transition_credentials` → `$KEY` env var (docs/commands), or a gitignored file
  that a script reads.
- Every CLI call bills the installed Claude Code/Codex account. An hourly premium-model cron adds
  up: schedule sparingly and pick the cheapest adequate model. `usage_report` estimates bash-mode
  agent usage, but command-launched model calls are invisible to it; journal those separately.
- Your own MCP host may block the first token write that triggers command execution — such
  classifiers guard exactly this action class and cannot see conversational consent. The fix is a
  narrowly-scoped allowlist rule in the host's settings (one tool, one project), never disabling
  the permission system.

## Windows executor: the /bin/sh bridge

The executor spawns `/bin/sh -c "<args.command>"`; Windows resolves `/bin/sh` against the current
drive root, i.e. `C:\bin\sh.exe`. One-time setup, no PATH or registry changes (rollback = delete
the two dirs):

1. Copy `C:\Program Files\Git\usr\bin\sh.exe` AND `msys-2.0.dll` (same dir) into `C:\bin\`.
2. Create an empty `C:\tmp\` — silences the MSYS warning that otherwise prefixes every stdout.

TRAP: Git's *other* `sh.exe` (`...\Git\bin\sh.exe`, ~47KB) is a launcher that resolves bash
relative to its own location — copied to `C:\bin` it does NOT work. Use the ~2.5MB
`usr\bin\sh.exe`. Inside this shell there is no MSYS mount table and no GNU userland: use Windows
paths with FORWARD slashes (`C:/Users/<you>/project/.venv/Scripts/python.exe`, never `/c/...`),
an absolute `args.workingDir`, and keep paths space-free so `args.command` needs no inner quotes
at all.
