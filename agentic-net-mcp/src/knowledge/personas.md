# Persona-first Agentic-Nets

Start with **who owns the outcome**, then express that specialist as a net. A newcomer grasps
"project developer" or "health coach" faster than an anonymous workflow. The Petri net underneath gives
the persona memory, boundaries, observable state, schedules, collaborators, and safe hand-offs.

Use a plain workflow when identity or context adds no value. A deterministic HTTP fetch or map
should stay an HTTP/map lane. But when work benefits from a role, a charter, domain
memory, or collaboration, propose a named persona or team before presenting raw transitions.

## The minimum useful persona

`spawn_persona` creates this complete shape:

- `p-<name>-charter` — identity, responsibility, capability, and execution backend.
- `p-<name>-task` — inbox. People, schedules, tools, and other agents can all add task tokens.
- `t-<name>-work` — one bounded agent fire per task, with a maximum reasoning loop.
- `p-<name>-output` — durable results that people or downstream nets can inspect and consume.

A good charter states: **role**, **outcomes**, **domain**, **boundaries**, **tools it may use**,
**when to ask a human**, and **what a result looks like**. Add a journal place when its
observations should accumulate, a feedback place when a person will rate results, and config places
for preferences that can change without rewriting the agent.

Examples:

- Developer: owns a repository change; may inspect/run tests; reports files changed, checks, and
  risks. Pair with a reviewer persona through `p-developer-output → p-reviewer-task`.
- Health coach: tracks goals, constraints, check-ins, and reflections; suggests small next actions;
  never diagnoses or replaces a clinician. Its journal is useful context, not a medical record.
- Domain expert: understands one business or technical domain. Write durable shared facts with
  `domain_memory_write`; every agent attached to the model can recall them.

Use `preset:"developer"|"reviewer"|"researcher"|"operator"|"assistant"` for a fast start, then
override `role`/`instruction` for the domain. `capability:"reason"` is the safe default;
`capability:"execute"` grants command, HTTP, logs, and tool-net use and should have a narrower
charter. `tier:"high"` is for genuinely difficult judgment, not a status badge.

## Choose the brain before starting it

Call `llm_health`, then make the execution route explicit:

| Situation | Preferred persona lane | Runs unattended? |
|---|---|---|
| Server provider READY/ONLINE | `agent` with API mode (the default) | yes, on master |
| No server provider; Claude Code installed | `agent`, `llmMode:"bash"`, `binary:"claude"` | yes, on master |
| No server provider; Codex installed | `agent`, `llmMode:"bash"`, `binary:"codex"` | yes, on master |
| Connected host model should reason | external fire or `host_transition` | only while connected |

`spawn_persona {execution:"auto"}` performs the provider preflight. With a ready provider it chooses
the server; without one it creates an honest `connected-client` lane. An explicit
`execution:"claude-code"|"codex"` is checked against master's probe
(`llm_health.headlessCliBinaries`) and refused when the binary is unreachable — a persona built
anyway would exit 127 on every fire. A Claude Code or Codex client on the same Desktop machine
should propose its matching backend when background work matters.

CLI-backed `agent` lanes are usually better than a raw command for personas: they preserve the
bounded agent loop, capability checks, tools, context, auto-emission, audit, and estimated
`usage_report` records. Use a `command` lane for a one-shot job whose entire contract is
stdin → stdout (exact invocations, the stdin-pipe rule, and Windows setup: docs/real-agents).
The CLI account pays for both; command-launched calls are invisible to `usage_report`, so journal
that cost separately if it matters.

## Teams are specialists connected by places

Do not build a single all-powerful coordinator. Build a small team whose responsibilities are easy
to explain:

1. A concierge/triage persona turns an incoming goal into a clear task and routes it.
2. Domain specialists (developer, analyst, coach, operator) work only their inboxes.
3. A reviewer or safety persona returns `approved`, `needs-work`, or `blocked` tokens.
4. Deterministic map/pass lanes move those verdicts; a human-review place is a deliberate pause.
5. A journal/protocol place records milestones so the team can be audited and resumed.

This is the reusable **safe-team playbook**: visible stages, bounded roles, explicit review, no
hidden chat-state. Install a team with `hub_search {kind:"agent"}` → `hub_show` → `hub_install`,
configure its declared places while stopped, attach required contexts, then start it. The built-in
dev-team template is a token-free variant where the connected coding client is the worker; it is
useful when the host already has excellent repository tools.

Parallel specialists share places instead of sending private messages. One output may feed several
review inboxes; capacity adds backpressure; `FOREACH` processes independent items; status tokens make
blocked/ready/done visible. Use a coordinator persona only for decisions that actually need
judgment; routing and bookkeeping should remain deterministic.

## Context nets turn domain knowledge into a playbook

A context net is reusable knowledge and policy, separate from the persona that consumes it. Typical
stores are knowledge, journal, decisions, constraints, examples, and insights. Attach the same
context to a developer team, a reviewer, and an assistant instead of copying prompts among them.

Create or install the context, declare attachment places, then use `ATTACH_CONTEXT` or
`memory_link`. `kind:"link"` transitions are typed graph edges (`contains`, `references`,
`derives-from`, `supersedes`, `promotes-to`); they **never fire** and never move tokens. Agents
navigate them with `GET_LINKED_PLACES`/`memory_graph`. This makes a playbook inspectable: a team can
see which charter uses which domain rules, examples, and earlier decisions.

Prefer one model per domain when pause, budget, cleanup, or ownership should be independent. A
domain-expert persona plus model-owned domain memory becomes the front door: ask it questions, let
specialist teams write verified lessons back, and retain provenance in the journal.

## Self-learning without silent self-rewriting

"Self-learning" should mean evidence accumulates and improvements become reviewable, not that an
agent secretly edits its own rules.

- Work writes outcomes and observations to a journal.
- Feedback links successes/failures to the task and context version that produced them.
- A context-curator persona proposes concise updates, deduplicates facts, and marks contradictions.
- A crystallizer finds repeated successful reasoning and proposes a deterministic map/command/tool
  net. `crystallize_session` captures a live procedure; `scaffold_tool_net` makes it reusable.
- A reviewer or human approves promotions. Typed links retain `derives-from` and `supersedes`
  history, so rollback is possible.

That loop is the deeper power of Agentic-Nets: personas do novel work, event-sourced tokens preserve
what happened, context nets retain what was learned, and repeated patterns crystallize into cheaper,
safer deterministic transitions. Monitor with `net_stats`, `scheduler_status`, `event_trail`, and
`usage_report`; `pause_model` is always the whole-domain kill switch.

## What to propose to a newcomer

Translate a goal into this short offer before building: "I can create a **named specialist** with a
charter, inbox, memory/context, and results; choose how it reasons; then add a reviewer or a schedule
only if useful." Show the backend and whether it runs while disconnected. For a team, name each
member and hand-off before revealing the net. This keeps the product persona-first.
