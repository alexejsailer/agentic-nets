/**
 * The teach-the-client primer, returned as MCP server `instructions` at
 * initialize. Any competent MCP client reads this once and knows how to use
 * Agentic-Nets well — the difference between a great and a frustrating session.
 */
import type { McpConfig } from './config.js';

export function buildInstructions(config: McpConfig): string {
  const models =
    config.models.length === 1
      ? `All tools operate on the model '${config.models[0]}'.`
      : `Allowed models: ${config.models.join(', ')} (default '${config.models[0]}'; pass \`model\` to target another).`;

  return `# Agentic-Nets — working memory that runs

You are connected to AgenticNetOS: a Petri-net workflow OS. PLACES are persistent, event-sourced
containers of JSON TOKENS; TRANSITIONS consume tokens from input places, act (transform / LLM call /
HTTP call / shell command), and emit results to output places. Everything you store here survives
this session, is queryable, and can be PROCESSED AUTONOMOUSLY by scheduled transitions while you
are gone. ${models}

## When to use what
- Persist anything worth remembering: memory_write (inbox for raw capture, notes default,
  decisions for choices made, knowledge for durable facts). Recall with memory_recall; navigate
  related context with memory_graph; connect places with memory_link.
- Give the user a ready-made system: deploy_template (working-memory | dev-team | brain | blank).
  dev-team makes YOU the worker of a persistent pipeline: query_tokens p-team-task-ready,
  fire_once t-team-claim, do the work, fire_once t-team-submit / t-team-complete.
- Build automation: add_place + add_transition (kinds: map=deterministic transform, llm=one AI
  call, http=API call, command=shell via executor, agent=autonomous multi-step persona,
  link=pure structure edge). Transitions you schedule (scheduleCron/intervalMs) keep running
  server-side after you disconnect.
- Crystallize a session: crystallize_session records what was discussed AND the concrete steps
  (API calls / commands) into memory, and bakes those steps into a replayable command tool-net.
  For a single reusable capability, scaffold_tool_net once, then invoke_tool_net forever —
  deterministic replay at zero LLM cost. Prefer these to re-reasoning a known workflow.
- Spawn autonomous workers: spawn_persona stands up a COMPLETE self-driving persona net (charter +
  task inbox + a started agent transition + output). Feed it via memory_write place:"p-<name>-task"
  and it works each task on its own, server-side. Spawn several — they run in PARALLEL while you
  keep working here. capability:"execute" (rwxhl) may run commands / invoke tool-nets; default
  "reason" (rw--) is safe. tier:"high" uses the thinking model.
- Monitor & debug WITHOUT logs or source: net_stats (LLM consumption, which transitions are
  RUNNING vs stopped/error, what is SCHEDULED to fire on its own, tool-net usage, recent errors)
  -> event_trail (the provenance trail, "why does memory say X" / what a persona did) ->
  query_tokens on suspect places -> and, on a specific transition, verify_inscription (static
  wiring check), dry_run_transition (simulate a fire), diagnose_transition (health + bindings).
  net_overview gives structure. This is your whole cockpit for the parallel personas you spawned.

## Two tool layers — curated (lowercase) and native (UPPERCASE)
The lowercase tools are the ergonomic layer: pre-wired inscriptions, session fallbacks, engine
gotchas absorbed — prefer them for the flows they cover. The UPPERCASE tools are the FULL native
platform catalog (the exact same tools agent transitions use in-net), exposed 1:1: structure
surgery (SET_INSCRIPTION, ADAPT_INSCRIPTIONS, CREATE/DELETE_PLACE|ARC|NET|TOKEN), deep diagnosis
(NET_DOCTOR, VERIFY_NET, GET_NET_STRUCTURE, VERIFY_RUNTIME_BINDINGS), cleanup (DELETE_NET removes
debris nets), packages (PACKAGE_SEARCH/PUBLISH/INSTALL), Docker/registry ops, EXPORT_PNML backup,
raw HTTP_CALL, and more — see the agenticnets://tool-catalog resource for the complete list.
Anything the platform can do, you can do here; nothing requires dropping to raw REST.

## Scheduling — nets that run while everyone sleeps
Any non-link transition accepts a schedule: scheduleCron (6-field cron: sec min hour day month
weekday, e.g. "0 0 3 * * *" = 03:00 nightly) or intervalMs — via add_transition, spawn_persona, or
set_schedule on an existing transition. A scheduled transition ticks SERVER-SIDE, forever, with no
client connected: overnight digests, periodic watchers, self-initiating personas. TELL THE USER
when you schedule something — they should know their net will act (and possibly spend LLM) on its
own. net_stats.scheduled lists everything armed, so always check it before assuming a model is idle.

## Spawning Claude Code (or any CLI agent) from a net
command transitions execute shell on the distributed executor — including spawning FULL Claude Code
instances: nets that delegate whole coding tasks to a fresh agent, overnight. The safe pattern:
  claude -p '<task prompt>' --allowedTools 'Read,Grep,Glob' --no-session-persistence < /dev/null
ALWAYS redirect stdin (< /dev/null) or the process hangs forever; ALWAYS confine with
--allowedTools (least privilege — add Edit/Bash only when the task truly needs it); set the
inscription timeoutMs generously (minutes, not seconds). This requires the executor host to have
the claude CLI installed and is rw-mode power — treat it like production shell access.

## Model control — the user owns the switch
You must be able to answer "what is this model consuming and how do I stop it":
- net_stats = the meter: LLM calls/errors/avgMs per transition, what is RUNNING, what is scheduled,
  recent errors, plus a paused flag.
- pause_model = the kill switch: stops EVERY running transition (no fires, no LLM spend, no
  schedules ticking) and records the set as an audit token in p-mcp-control.
- resume_model = restores exactly the paused set. stop_transition/start_transition = one lane.
When the user asks to "switch it off", "freeze it", or "stop spending", reach for pause_model
first and report what was stopped.

## Rules that save you from real engine gotchas
1. ArcQL: double equals and double quotes — FROM $ WHERE $.status=="active" LIMIT 5. Paths start with $.
2. \${input.data.field} in prompts/templates interpolates the INPUT TOKEN's fields; the root name
   is the preset key (default 'input').
3. link transitions NEVER fire — they are navigable edges only. Never start them.
4. A capacity-N output place blocks its producer when full (backpressure, not an error).
5. fire_once returns 409 while a transition is RUNNING — stop_transition first, fire, start again.
6. assign/set_schedule stops a transition; the tools here restart it for you — but remember it if
   you work the REST API directly.
7. Prefer deterministic kinds (map/http) wherever possible; use llm/agent transitions only where
   judgment is genuinely needed — that is what makes nets cheap and reliable. A crystallized
   command tool-net (crystallize_session / scaffold_tool_net) beats re-reasoning a known workflow.
8. Agent personas (spawn_persona) auto-route their result via autoEmit — so verify_inscription may
   report a MISSING_EMIT warning on them; that is expected and benign, not a failure.

Read agenticnets://docs/concepts for the full model, agenticnets://docs/recipes for patterns.`;
}
