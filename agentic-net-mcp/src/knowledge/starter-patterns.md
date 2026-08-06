# Starter patterns: learn the platform through small nets

Safe Product Team is one worked product-delivery example, not the default answer to every goal.
Choose the smallest starter that demonstrates the concept the user needs, then compose starters
through typed places and links. Templates teach architecture; they are not opaque applications.

## Shipped starters

| Starter | Teaches | Reasoning/runtime |
|---|---|---|
| `blank` | Minimal design-time/runtime net | none |
| `working-memory` | inbox, durable stores, context links | server LLM |
| `brain` | divergent/convergent reasoning lanes | server LLM |
| `watcher` | schedules, commands, executor, durable log | none |
| `dev-team` | WIP, hand-offs, review, context, Protocol | connected worker or added personas |
| `headless-cli-reviewer` | MAP → CommandToken → COMMAND → result | Claude Code or Codex on executor |
| Agent Hub `safe-product-team` | bounded multi-persona governance | server LLM; reasoning-only |
| Agent Hub `model-steward` | evidence-based review of any model | server LLM or MCP fallback |

For `headless-cli-reviewer`, call `list_executors`, then deploy with `binary:"claude"|"codex"`
and an absolute executor-visible `workingDir`. Write `{prompt,_correlationId}` to
`p-cli-review-inbox`; read `p-cli-review-results`. Its command is fixed and read-only. Dynamic task
text travels through `args.env`, not shell interpolation, so quotes in a task cannot become code.

## Pick the execution pattern explicitly

- A fixed build, test, converter, CLI, or script is a `command` transition on an executor.
- A one-shot headless model call on an executor is MAP → COMMAND. Use it when stdin→stdout is the
  whole contract; `headless-cli-reviewer` is the reference.
- A persistent persona using Claude Code/Codex is an `agent` transition with
  `llmMode:"bash"` and `binary:"claude"|"codex"`. It retains the bounded agent loop, tools,
  capabilities, context, and unattended scheduling.
- With a healthy server provider, use ordinary `agent`/`llm` transitions.
- With only a connected model, use external fire or `host_transition`; work waits after disconnect.

Never label a command-spawned CLI as deterministic reasoning. The routing and invocation are
deterministic; the model output is not. Record binary/backend, prompt/context version, result, and
correlation ID so it remains historically analyzable.

## Next reusable templates to build

Prioritize concept coverage over domain count:

1. **Guarded Persona** — domain-neutral charter/inbox/context/outbox/Protocol with backend chooser.
2. **Approval-Gated Operator** — reviewer verdict → expiring approval → narrow command/tool-net;
   demonstrates that reasoning and external authority are separate.
3. **Context Playbook** — versioned policies, glossary, decisions, incidents, lessons, and typed link
   relations; useful to every domain persona.
4. **Incident Triage** — scheduled probe → deterministic classification → specialist only on novel
   failures → approval-gated remediation.
5. **Human Review Gate** — WIP, timeout, escalation, approve/reject/rework routing without an LLM.
6. **Learning and Crystallization Lab** — journal → candidate pattern → review → tool-net proposal →
   smoke test → version comparison, never hidden self-modification.

After those primitives, create domain examples—research review, compliance intake, customer support,
care coaching, procurement, or manufacturing—but build them by composing the same tested patterns.

## MCP design rule

When asked to build something, first name the persona or operational outcome, then search this
catalog for the smallest matching pattern. State provider/executor availability, side effects,
approval boundary, inbox/outbox, observability contract, and offline behavior before deployment.
Use Safe Product Team only when its product-delivery roles genuinely match the request.
