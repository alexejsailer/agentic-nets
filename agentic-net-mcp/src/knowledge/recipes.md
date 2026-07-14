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
with your own work here. capability:"execute" (rwxhl) lets it run commands / invoke tool-nets;
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
  claude -p 'Fix the failing test in /repo/x' --allowedTools 'Read,Grep,Glob,Edit,Bash' --no-session-persistence < /dev/null
Rules: ALWAYS < /dev/null (stdin blocks forever otherwise); confine --allowedTools to least
privilege; timeoutMs in minutes; the executor host needs the claude CLI. This is how a persona can
"hire" a coding agent overnight — the net stays deterministic, the spawned agent does the fuzzy work.
With several executors registered, check list_executors and pass executorId on add_transition to
pick the host that runs it ('*' = any executor; if more than one is ONLINE and the user didn't
specify, ask which to target). Full command-lane reference: docs/commands.

## The kill switch (full model control)
pause_model stops EVERY running transition — zero fires, zero LLM spend, schedules frozen — and
records what was running as an audit token in p-mcp-control. resume_model restores exactly that
set. One lane: stop_transition / start_transition. The meter: net_stats (paused flag, llm.calls,
scheduled list). "Switch it off" => pause_model; verify with net_stats.paused==true.

## When something is broken
The playbooks live in docs/troubleshooting: stuck lane, command "queued but no output",
scheduled-but-silent, dead LLM lane, and the new-model checklist.
