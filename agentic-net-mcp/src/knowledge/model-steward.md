# Model Steward: domain-neutral review of nets and processes

The Model Steward is a built-in NetHub `kind=agent` package that reviews the model containing it.
It is deliberately domain-neutral: a place may represent a software story, a clinical follow-up,
an approval, a research claim, a manufacturing batch, or any other typed state. The Steward reviews
the net contract and the evidence without pretending to know an unstated business outcome.

Install it from NetHub as `model-steward`. Installation lands stopped. With a healthy server LLM,
start the agent session after inspecting its charter. With no server provider, leave it stopped and
let the connected MCP model perform the same review interactively with the curated observability
tools.

## What it reviews

The on-demand lane accepts a scope (`model|session|net|transition|correlation`), optional target ID,
time window, and question. The scheduled pulse surveys the whole model. Both use the same lenses:

- flow, WIP/backpressure, waiting and bottlenecks;
- correctness, inscription/runtime binding, and error routing;
- authority, credentials boundaries, and unsafe side effects;
- event provenance, structured status, and readable reporting;
- cost/efficiency, schedules, executor coverage, and idle work;
- context quality, missing typed links, and stale assumptions;
- resilience, retries, pause/stop behavior, and recovery;
- repeated reasoning that might be crystallized into a deterministic tool-net.

It writes a readable report to `p-ms-reports`, flat issue rows to `p-ms-findings`, its evidence
queries/limitations to `p-ms-journal`, and meaningful summaries to `p-protocol` (scheduled no-change
heartbeats are suppressed). Each finding separates observation from inference and cites evidence.

## Safety boundary

The shipped capability profile grants model/net/token reads, event-history reads, and `CREATE_TOKEN`
only to the three `p-ms-*` outputs plus the model's `p-protocol`. It excludes structural writes, operational token
writes, transition lifecycle, schedules, credentials, HTTP, commands, Docker, delegation, and
tool-net invocation. It can recommend a change; it cannot apply it.

This separation matters for reflexive systems: observing a model must not silently become modifying
the model. A user or a separately approval-gated Operator reviews the recommendation, applies one
small versioned change, verifies it, and records the result in Protocol.

## Interactive provider-free review

On Desktop Lite without a server LLM, use `net_stats` for the whole-model runtime snapshot, then
`net_overview`, `query_tokens`, `scheduler_status`, `list_executors`, `usage_report`, and
`event_trail` for evidence. Report the same output contract as the installed Steward and finish
with `protocol_write`. Do not claim that the stopped NetHub agent performed the review.

For UNATTENDED provider-free review, the installed Steward's agent lanes can be switched to the
headless CLI backend: SET_INSCRIPTION each `t-ms-*` lane with `action.llmMode:"bash"` and
`binary:"claude"|"codex"` — but only when `llm_health.headlessCliBinaries` reports that binary
reachable (docs/real-agents). The advisory-only capability profile applies unchanged.

## Product position

The Safe Product Team is a complete worked example, not the boundary of Agentic-Nets. Agentic-Nets is
a domain-general backend for named personas, deterministic workflows, context nets, tool-nets,
approvals, schedules, and historically analyzable processes. The Model Steward demonstrates that
the same meta-agent can review all of those shapes without being coupled to software delivery.
