# Capability packs: delegate the operation, keep the knowledge server-side

A capability pack is an agent session that OWNS one operational domain: persona nets, deterministic
pipelines, a policy, an audit journal, and a machine-readable `agent-manifest`. A client does not
pull schemas, docs and intermediate results into its own context to hand-roll a multi-step
operation — it finds a pack and delegates: one small task token in, one verified result token out.

Why this is cheaper AND stronger than doing it yourself:

- **Context**: schemas, previews and intermediate results never cross the wire. One request, one
  structured reply.
- **Shared knowledge**: the expertise is server-side structure, not prose re-derived per session —
  every client of the stack benefits, including weak and headless ones.
- **Structural guards**: a gate transition refuses a forbidden target whether the caller is
  careful, confused, or prompt-injected. A charter is advice; a gate is a fact.
- **Honest numbers**: a well-built pack lets the agent DECIDE and a deterministic pipeline
  MEASURE. Counts in the reply come from map templates over real API responses — a model never
  authors them. (Field-proven: an agent that did its own bookkeeping reported "nothing deleted"
  after deleting 11 tokens, at two different tiers. Decide-then-measure fixed it.)

## Where packs live

The `default` model exists in every Agentic-Nets install, so it is the system capability registry.
`find_capabilities` searches it unless you pass `model`. Packs are ordinary agent sessions: the
session carries the `agents` tag and an `agent-manifest` leaf whose `entry` block is the
delegation contract (inbox place, outbox place, correlation field, input schema, howToUse).

## Using one

1. `find_capabilities {query?}` — compact list: name, domain, description, armed state, entry.
2. `delegate {capability, request, fields?, timeoutMs?}` — writes a correlated task token into the
   entry inbox and awaits the reply on the outbox. A timeout returns `pending:true` with the
   requestId; call `delegate` again WITH that requestId to re-await — it will not enqueue a
   duplicate. Never re-delegate a still-running task under a new id.
3. Read the reply's own status field. `refused` is a successful answer, not an error — the pack's
   policy said no, and nothing was touched.

## Building one (the shape that works)

- Agent lane parses NL → ONE intent token, role `rw` only, few iterations. It cannot execute.
- Deterministic pipeline: policy gate (regex verdict vs a literal, e.g. `verdict == 'DENY'`) →
  measure → execute → re-measure → compose the reply in a map template. Every terminal branch
  (done, refused, nothing-to-do, unsupported, failed) writes to the SAME outbox with the SAME
  correlation field.
- Policy as a config token (`consume:false, optional:false` preset), enforced by the gate, not by
  the charter. Start narrow, widen deliberately.
- Write the `agent-manifest`, tag the session `agents`, and verify `LIST_AGENT_SESSIONS` returns
  your entry contract. Then it is discoverable — and publishable via `hub_publish {kind:'agent'}`.

## When NOT to delegate

A single trivial read or write is faster done directly. Delegation pays when the operation is
repeated, carries judgement, or needs containment — it moves LLM cost server-side and adds seconds
of latency, which is a good trade exactly then.
