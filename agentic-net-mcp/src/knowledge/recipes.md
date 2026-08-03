# Recipes

## Working memory discipline
Capture fast (memory_write place:inbox), let the distiller clean it up, promote decisions
explicitly (place:decisions with a "why"), recall before big decisions (memory_recall), and check
provenance with event_trail when something looks wrong.

## Working the dev-team pipeline (you are the worker)
1. query_tokens p-team-task-ready — see what is ready (WIP-limited to 5).
2. fire_once t-team-claim — the task moves to in-progress.
3. Do the work with your own tools/reasoning.
4. memory_write a result summary, then fire_once t-team-submit.
5. After review: fire_once t-team-complete. The daily digest transition keeps a heartbeat in p-team-log.

## Building a scheduled watcher
add_place in/out -> add_transition kind:http (url, scheduleCron "0 */10 * * * *") -> results
accumulate in the out place -> add_transition kind:llm reading the out place to summarize anomalies.

For CSV, set the HTTP emit source to `@response.text`; parse that raw text in a downstream map or
command lane. `@response.meta` carries status, Content-Type/length, duration, and the masked request.

## Crystallizing (scaffold once, invoke forever)
When a capability is worth reusing, scaffold_tool_net with transitionKind=command|http|llm — the
trigger is pre-wired invoke-green by construction (input shapes: command⇒{command}, http⇒{url},
llm⇒{prompt}). Then invoke_tool_net {netId, input} calls it deterministically at zero LLM cost; the
master handles correlation/fire/poll. Discover existing tool-nets via agenticnets://tool-nets.

## Crystallizing a whole SESSION (record + replay)
After a working session, crystallize_session {title, summary, steps} does two things: (1) records
the summary/decisions to memory, and (2) compiles the deterministic steps — shell strings,
{command}, or {method,url,headers,body} (→ curl) — into a replayable command tool-net. It returns
toolNet.replay = {netId, sessionId, input}; run invoke_tool_net with exactly that to re-execute the
whole workflow later at zero LLM cost. Use it for "capture what we did so next time you just run it".

## Spawning autonomous worker personas (parallel colleagues)
spawn_persona {name, role, capability, tier} builds a complete self-driving net: a charter, a task
inbox (p-<name>-task), a STARTED agent transition that watches the inbox, and an output place
(p-<name>-output). Give it work with memory_write {place:"p-<name>-task", text:"..."}; it processes
each task autonomously, server-side, and emits a result — in parallel with every other persona and
with your own work here. capability:"execute" (rwxhl---t) lets it run commands / invoke tool-nets;
default "reason" (rw--) is safe. tier:"high" picks the thinking model. Spawn a small team (dev +
reviewer + researcher) and let them run while you steer.

## Overnight automation (cron / interval schedules)
Give any non-link transition a schedule and it ticks server-side with nobody connected:
- add_transition {kind:"llm", scheduleCron:"0 0 3 * * *", prompt:"Summarize yesterday's p-mem-inbox…"}
  = a 03:00 nightly digest. (6-field cron: sec min hour day month weekday.)
- spawn_persona {intervalMs:3600000, ...} = a persona that self-initiates hourly instead of waiting
  for tasks. set_schedule retrofits a schedule onto an existing transition.
Always tell the user what you armed (it will act — and possibly spend LLM — on its own), and check
net_stats.scheduled (plus scheduler_status for lastFiredAt/nextFireAt) to see everything that will
fire unattended. A schedule is an AND-gate with token binding — see docs/scheduling.

## Spawning Claude Code workers from a net
A command transition can launch a full Claude Code instance on the executor host — a net that
delegates entire coding tasks to a fresh agent:
  add_transition {kind:"command", ...} consuming command-shaped tokens whose args.command is
  printf '%s' 'Fix the failing test in /repo/x' | claude -p --model sonnet --allowedTools 'Read,Grep,Glob,Edit,Bash' --no-session-persistence
Pipe the prompt via stdin (a quoted -p argument can lose its quotes through the executor chain —
claude then runs promptless); least-privilege --allowedTools; timeoutMs in minutes; executorId
picks the host (list_executors; '*' = any — several ONLINE and unspecified: ask). This is how a
persona "hires" a coding agent overnight — the net stays deterministic, the spawned agent does the
fuzzy work. Full pattern + Windows setup: docs/real-agents; token schema: docs/commands.

## Orchestration: prefer deterministic chaining over an agent poll-loop

The robust way to run a multi-stage pipeline (review → fix → test, fan-out/fan-in, "do A then B
then summarize") is DETERMINISTIC token flow, not one agent that drives everything by polling:
wire each stage as its own map/http/command/llm lane and let the OUTPUT place of one stage be the
INPUT place of the next. A verdict/branch is an llm/map lane with mutually-exclusive `when` emits
(docs/emit). This is fully reachable over MCP and is reliable regardless of model strength — every
stage is a single, bounded LLM/command call.

An AGENT that orchestrates by looping AWAIT_TOKEN/QUERY_TOKENS over several places to collect
results, then writing a summary, is the fragile pattern. Observed failure (deepseek-class worker
model): the agent collects result A, then result B, but on each subsequent turn "forgets" it
already holds the other and re-collects — oscillating until maxIterations, never writing the
summary. The tool results ARE delivered correctly (AWAIT_TOKEN returns in milliseconds and the
reasoning quotes the real values); the weak worker model just can't hold "I now have BOTH" across
turns. THINK routes the *next single* call to the stronger thinking model but the boost is
one-shot, so it doesn't rescue a multi-collect loop.

If you must use an orchestrator agent: (1) keep it to the FEWEST steps — ideally collect nothing,
just dispatch, and let a downstream deterministic lane assemble the summary; (2) give it an
explicit "you now permanently HOLD X; never re-await it; when you hold all N, write immediately"
state rule; (3) run it on the strongest tier your deployment configures (tier:"high" only helps if
high maps to a stronger model than the default worker — verify with llm_health). When in doubt,
make the net deterministic and reserve the agent for the genuinely fuzzy single step.

## The kill switch (full model control)
pause_model stops EVERY running transition — zero fires, zero LLM spend, schedules frozen — and
records what was running as an audit token in p-mcp-control. resume_model restores exactly that
set. One lane: stop_transition / start_transition. The meter: net_stats (paused flag, llm.calls,
scheduled list). "Switch it off" => pause_model; verify with net_stats.paused==true.

## When something is broken
The playbooks live in docs/troubleshooting: stuck lane, command "queued but no output",
scheduled-but-silent, dead LLM lane, and the new-model checklist.

## New domain? Mint a model, don't pile into `default`

The model is the isolation boundary (places, schedules, memory, budget, pause).
Use create_model per substantial domain — mixing domains makes pause_model,
usage_report and cleanup all-or-nothing.

## Narrate long-running work: the protocol journal

protocol_write appends to p-protocol; nets journal themselves via an emit to it.
Studio renders the feed as the Protocol view (tray → Open Protocol). Write on
deploy / schedule armed / batch done / failure; protocol_tail reads it back.
