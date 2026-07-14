# Troubleshooting playbooks

Field-tested diagnosis ladders. Rule zero: run `diagnose_transition` BEFORE reasoning about a
stuck lane — never guess what a tool can tell you.

## Stuck lane (transition exists, nothing moves)

1. `diagnose_transition {transitionId}` — binding, preset ArcQL, token shape, live status.
2. If it reports healthy: compare the preset's ArcQL and the template's `${...}` paths against a
   REAL token (`query_tokens` on the input place). The two classic mismatches: ArcQL field vs
   actual token field; template prefix vs preset key (docs/interpolation).
3. `dry_run_transition` — what WOULD bind and emit, without firing.
4. `fire_once` returns 409 while RUNNING: stop_transition → fire_once → start_transition.
5. Downstream place at its capacity? That's backpressure, not a bug (docs/emit).

## Command lane: "queued: true, but no output"

Four checks, in order (full detail: docs/commands):
1. **Executor coverage** — `net_stats.executorCoverage` / `list_executors.coverageForModel`:
   `covered:false` = nothing polls this model; nothing will ever run.
2. Routing — `action.executorId` / `assignedAgent` names an executor that exists.
3. Action purity — the command action has NO `${...}`, no `command`/`cwd` fields.
4. The consumed token is a COMPLETE CommandToken (kind/id/executor/command/args.command with
   absolute workingDir).

## Scheduled-but-silent

`scheduler_status` first: lastFiredAt/nextFireAt/eligibility/overdue. The schedule is an AND-gate
with token binding — full ladder in docs/scheduling. `overdue:true` = post-redeploy freeze; kick
with stop → fire_once → start of any lane in the model.

## LLM lane dead

`llm_health` (provider READY?) → `net_stats.recentErrors` (timeouts? quota?) → check for the
`{text, parseError}` fallback shape in the output place (docs/llm) → verify `action.model`/`tier`
name a model that exists. Remember: on masters < 2.28 a failed llm fire emits nothing.

## New-model checklist (before building anything)

1. `create_model` (or confirm it exists — `list_models` shows state; CATALOGED ≠ loaded).
2. First `add_place` succeeds ⇒ workspace skeleton is provisioned (auto on ≥ 2.27).
3. Command lanes planned? `list_executors` — is anything polling / allowed to poll this model?
4. LLM lanes planned? `llm_health` says READY.
5. Remember `net_overview` without netId is SESSION-scoped: `sessionNetCount: 0` on a fresh
   connection does NOT mean the model is empty — check `modelSessionCount`.

## Provenance & history

`event_trail` is the audit log: filter with `q` (free text), `correlationId`, `category`,
`status`; page into older history with `before: <nextBeforeSeq>` (limit caps at 200 — bigger
windows truncate). Manual fires narrate on masters ≥ 2.28; on older masters a fireOnce of a
stopped trigger runs INVISIBLY — if you need its trail there, start the trigger (a running
trigger picks up invoke tokens anyway).

## When you cannot explain it

`net_stats` end to end (statuses, scheduled, executorCoverage, llm consumption, recentErrors),
then `search_knowledge` with the symptom — the answer is usually one of the traps above.
