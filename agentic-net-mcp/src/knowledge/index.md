# Start here: the knowledge base

Bundled operational docs — the same knowledge a platform developer works from, curated for MCP
clients. Search with the `search_knowledge` tool; read topics as `agenticnets://docs/{topic}`.

## The reading protocol

Search first (`search_knowledge {query: "<symptom or concept>"}`), read at most the 1-2 topics it
points at, act. When something is broken, go straight to `troubleshooting`. Before writing an
inscription by hand, read `inscriptions`.

## Topics

- **personas** — START HERE for product design: named specialists, execution-backend choice,
  developer/health-coach/domain-expert examples, safe teams, context playbooks, and the
  journal→curator→review→crystallization learning loop.
- **starter-patterns** — START HERE when choosing a reusable example: shipped small nets, the
  command-vs-CLI-agent distinction, and the prioritized template catalog.
- **safe-product-team** — one complete product-delivery example: PM/Architect/Developer/Reviewer/
  Release Guardian/Chronicle, repository context, review gates, Protocol, and crystallization.
- **model-steward** — a domain-neutral meta-agent for evidence-based review of current models,
  sessions, nets, transitions, process flow, safety, observability, and crystallization candidates;
  includes the advisory-only boundary and provider-free interactive fallback.
- **concepts** — places/tokens/the seven transition kinds; deterministic-first; where things live.
- **architecture** — the two layers (PNML drawing vs runtime machine); the "inscriptions bind
  RUNTIME places" rule; host format; lifecycle; why a fresh session looks empty.
- **inscriptions** — complete per-kind templates (pass/map/http/llm/command/agent/link) with
  allowed-fields lines; credentials; the universal rules.
- **arcql** — token query syntax; preset extras (take/consume/optional); top mistakes.
- **interpolation** — `${...}` paths; THE preset-key rule; type preservation; the function set
  (urlencode/sum/len/default/lower/upper/trim).
- **emit** — from-expressions; `when` semantics; success/error split; the catch-all rule;
  capacity backpressure; correlation.
- **commands** — CommandToken schema; MAP→COMMAND; executor selection; the "queued, no output"
  coverage diagnosis; spawning CLI agents safely.
- **tool-catalog** — the durable tool registry: four flags (d docker / h http / t tool-nets /
  s scripts), global vs local-first scoping with shadowing, contract-vs-binding, the sha256
  double-check that makes `approved` mean something, invoking scripts by toolId.
- **llm** — llm_health pre-flight; tier & error-branch behavior (and old-master caveats); the
  @response.json parse fallback; agent two-tier config; cost discipline.
- **applications** — Protocol/Interview/Goals as ordinary nets with a manifest: discover roles
  instead of hardcoding places, the two-way Interview contract (ask / respond with intent /
  raise), and how to ask a human WITHOUT holding a transition lease.
- **approvals** — Approval Room's blind-Persona discovery, separation-of-duty guard, canonical plus
  audit stores, and idempotency rules for ambiguous responses.
- **external-fire** — YOU are the LLM: the list/prepare/complete loop, leases, servable verdicts,
  what provider-less mode means for provider-backed llm/agent lanes and CLI-agent exceptions.
- **real-agents** — personas as scheduled nets; the FIVE reasoning paths (server lane, CLI-backed
  agent lane, headless CLI via command lane, external fire, host_transition) and when each; the stdin-pipe
  spawn; workingDir as context switch; the Windows /bin/sh bridge.
- **scheduling** — 6-field cron; the schedule×tokens AND-gate; the silent-scheduler diagnosis
  ladder; the autonomy contract.
- **cost** — the token meter: usage_report ranks per-transition burn; the analyze-rank-retune-watch
  loop; live intervalMs edits; the invisible script-spawned-model-call category.
- **nethub** — export/import: publish kinds (net/session/application/model/agent/context/toolnet/tool/catalog/blob),
  self-contained packages (dependencies travel sha256-pinned, installed scope-aware), token
  policy + credential scrubbing, federation via remotes.
- **mcp-servers** — agent transitions calling EXTERNAL MCP servers (including an Agentic-Nets
  server): the four gates (m flag / declaration / allowTools / vault credential), handing this
  server to an agent, verifying without spending tokens, degrade-never-fail semantics.
- **leases** — who is working on what: the `_lock` CAS+TTL mechanism, why binding hides
  foreign-leased tokens while `query_tokens` shows them, external fires as leases, and why
  deleting a leased token breaks the fire that holds it.
- **tokens** — stringified properties (parse, sometimes twice); size discipline; client-side
  truncation caution; config tokens; design-time `tokens: 0` ≠ live state.
- **troubleshooting** — the playbooks: stuck lane, queued-no-output, scheduled-but-silent, dead
  LLM lane, new-model checklist, provenance.
- **recipes** — end-to-end patterns: working memory, dev-team pipeline, watchers, crystallization,
  personas, overnight automation, the kill switch.
- **security** — the model allowlist honestly explained; readonly boundaries; the ONE sanctioned
  secret path.

## Version note

The pack tracks platform 2.28. Features marked with a version (template functions ≥ 2.27; llm
tier/error-emit, eligibility, fireOnce narration ≥ 2.28) are absent on older masters — the docs
say so inline where it matters.
