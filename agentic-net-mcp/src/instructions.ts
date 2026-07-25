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
- Persist into the MODEL's OWN memory base (shared with the domain-expert persona and the
  Genesis/agent MEMORY_WRITE tool): domain_memory_write / domain_memory_recall — stores in the
  model's domain net (p-{model}-domain-{knowledge|journal|insights}). Use this when the memory
  belongs to the model/domain itself and should be visible to every agent that reaches it, rather
  than to this MCP session's working-memory (p-mem-*).
- Give the user a ready-made system: deploy_template (working-memory | dev-team | brain | watcher
  | blank). dev-team makes YOU the worker of a persistent pipeline: query_tokens p-team-task-ready,
  fire_once t-team-claim, do the work, fire_once t-team-submit / t-team-complete. watcher is the
  zero-LLM overnight sentinel: cron-probes a URL and POSTs a webhook alert when it is not 200
  (params: url, webhook, cron, label) — deploy it when the user wants "tell me when it breaks".
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
  keep working here. capability:"execute" (rwxhl---t) may run commands / invoke tool-nets; default
  "reason" (rw--) is safe. tier:"high" uses the thinking model.
- Monitor & debug WITHOUT logs or source: net_stats (LLM consumption, RUNNING vs stopped/error,
  what is SCHEDULED, executorCoverage — can command lanes even fire? — tool-net usage, recent
  errors) -> list_transitions (the model audit: every transition's kind + schedule + status +
  places in ONE call) -> scheduler_status (lastFiredAt / nextFireAt / why-not-eligible per lane)
  -> event_trail (provenance; page older history with before) -> query_tokens on suspect places
  -> and, on one transition, verify_inscription / dry_run_transition / diagnose_transition.
  net_overview gives structure (session-scoped without netId — sessionNetCount 0 ≠ empty model).

## Models — the whole stack, through the protocol
list_models shows every model node knows, each with an "allowed" flag (which ones THIS connection may
target). create_model (rw, when enabled) mints a brand-new model — optionally deploying a starter
template into it in the same call — and it joins this session's allowlist immediately, so any tool
can target it with the model param. Master auto-discovers active models within ~10s and begins
polling their transitions. Sessions: CREATE_SESSION. Nets: create_net. Everything AgenticOS can do
is reachable here — nothing requires the raw REST API.

## Cleaning up — no orphaned registrations
DELETE_NET removes a net's structure; pass deleteTransitions:true to ALSO deregister its runtime
transitions. DELETE_TRANSITION deregisters a single runtime transition (stop + remove
inscription/status/assignment) — use it to clear transitions left STOPPED behind a deleted net so
net_stats stays honest. Irreversible; re-assign to recreate.

## NetHub — share and install nets, sessions, whole models
hub_publish {kind, name, version, tokens} turns a net / session / model into a versioned shareable
artifact (credentials always scrubbed; tokens = none | config | all). hub_search browses the local
catalog or a peer's (remote param); hub_show inspects one artifact before committing; hub_install
installs (model artifacts create a NEW model that joins your allowlist). Federate with
hub_add_remote — peers serve anonymous reads only with their public-catalog flag on. Details live
in the tool descriptions.
Ready-made agents: hub_search {kind:"agent"} finds installable persona-team templates (health
coach, dev crew, ...). hub_install lands one STOPPED in its own agent-<name> session and returns a
configure-then-start checklist — fill the required config places (CREATE_TOKEN), then arm with the
native START_AGENT_SESSION; STOP_AGENT_SESSION disarms. LIST_AGENT_SESSIONS shows what is installed
and whether it is running/configured. Talk to an armed agent through its manifest entry inbox place.
Context nets: hub_search {kind:"context"} finds installable context templates. hub_show exposes their
named stores, scope, hierarchy, attachments, data policy, and maintenance startPlan. hub_install puts
one in its own context-<name> session. Structural kind=link transitions express semantic/hierarchical
relationships and never fire; START_CONTEXT and STOP_CONTEXT control only maintenance transitions.
Wire a declared attachment (e.g. a parent context) with ATTACH_CONTEXT {sessionId, attachment,
targetPlaceId} — it creates the typed link; links carry an optional "relation" (contains,
derives-from, promotes-to, ...) readable via GET_LINKED_PLACES and memory_graph.
Agent manifests can declare required or optional contexts, and START_AGENT_SESSION reports readiness.

## Two tool layers — curated (lowercase) and native (UPPERCASE)
The lowercase tools are the ergonomic layer: pre-wired inscriptions, session fallbacks, engine
gotchas absorbed — prefer them for the flows they cover. The UPPERCASE tools are the FULL native
platform catalog (the exact same tools agent transitions use in-net), exposed 1:1: structure
surgery (SET_INSCRIPTION, ADAPT_INSCRIPTIONS, CREATE/DELETE_PLACE|ARC|NET|TOKEN), deep diagnosis
(NET_DOCTOR, VERIFY_NET, GET_NET_STRUCTURE, VERIFY_RUNTIME_BINDINGS), cleanup (DELETE_NET removes
debris nets), packages (PACKAGE_SEARCH/PUBLISH/INSTALL), Docker/registry ops, EXPORT_PNML backup,
raw HTTP_CALL, and more — see the agenticnets://tool-catalog resource for the complete list.
Anything the platform can do, you can do here; nothing requires dropping to raw REST.

## Hosting transitions HERE (client-side LLM — no server-side model needed)
host_transition executes an llm/agent transition IN THIS PROCESS instead of on master, using the
LLM this side already has (default: the local claude binary). Build the lane with add_transition
{kind:"llm"|"agent", start:false} — start:false means master never runs it — then host_transition
{transitionId, mode:"watch"} to keep working arriving tokens, or mode:"once" for a single
execution. Stats live in net_stats.hosted; stop with unhost_transition. Honest rule: hosted lanes
run only while this session is connected — tokens wait safely in the input place meanwhile. Put
lanes that must run 24/7 unattended on master (llm kind with a server-side model) instead.

## External fires — YOU are the LLM (no provider config at all)
The third execution mode: set_external {transitionId, external:true} (bulk: transitionIds / netId /
sessionId / all:true) marks an llm/agent transition status "external" — master's schedulers skip it
and tokens wait in its input places until a client fires it. Model/session/net choices persist and
apply to newly deployed transitions carrying matching metadata; a transition choice overrides them.
Then: list_external_fires shows which
have work; prepare_external_fire {transitionId} returns the EXACT interpolated prompt (llm) or nl
instruction (agent) plus leased bound tokens + fireId. For agents it also returns the exact
allowedTools/resourceScopes; use only those tools (master authorizes every call). You reason AS THE
HOST MODEL; complete_external_fire
{transitionId, fireId, response | emissions | summary} hands the answer to master, which runs the
same emit-rule pipeline as a master fire, consumes the shown tokens, and books usage as
provider external:mcp-<session> (never against the master LLM breaker). success:false or
abandon_external_fire preserves the inputs. Mixed nets are normal — some llm/agent transitions on
master, others external, in one net. Difference vs host_transition: external fires use the HOST
MODEL itself (zero provider setup, master keeps emit semantics); host_transition runs a separately
configured provider unattended in this process. start_transition returns a lane to master.

## Scheduling — nets that run while everyone sleeps
Any non-link transition accepts a schedule: scheduleCron (6-field cron: sec min hour day month
weekday, e.g. "0 0 3 * * *" = 03:00 nightly) or intervalMs — via add_transition, spawn_persona, or
set_schedule on an existing transition. A scheduled transition ticks SERVER-SIDE, forever, with no
client connected: overnight digests, periodic watchers, self-initiating personas. TELL THE USER
when you schedule something — they should know their net will act (and possibly spend LLM) on its
own. net_stats.scheduled lists everything armed; when scheduled lanes look silent, scheduler_status
gives lastFiredAt / nextFireAt / why-not-eligible per lane (a schedule is an AND-gate with token
binding — docs/scheduling explains the trap).

## Spawning Claude Code (or any CLI agent) from a net
command transitions execute shell on the distributed executor — including FULL Claude Code
instances. The safe pattern:
  claude -p '<task prompt>' --allowedTools 'Read,Grep,Glob' --no-session-persistence < /dev/null
ALWAYS redirect stdin (it hangs forever otherwise); least-privilege --allowedTools; generous
timeoutMs. Multiple executors: list_executors shows them + coverageForModel (is anything even
polling this model? — the "queued, no output" diagnosis); pick one via add_transition's executorId
('*' = any; if several are ONLINE and the user didn't say, ASK). Full reference: docs/commands.

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
9. Secrets go through set_transition_credentials + \${credentials.KEY} in the inscription — NEVER
   inline in an inscription or into a token: tokens are event-sourced, a pasted secret is permanent.
10. LLM lanes: check llm_health BEFORE building (a not-READY provider fails every fire, billed);
    give every llm lane an error emit branch. add_transition emits @response.json so a
    prompt-for-JSON lane's fields interpolate downstream (\${input.data.field}); @response.raw
    stores the reply as an escaped string under 'value' — only for freeform text (docs/llm).
11. Templates have functions: \${urlencode(...)} for ANY url built from data (raw #/space/&
    silently corrupts it), plus sum/len/default/lower/upper/trim — docs/interpolation.

## The knowledge base — search it, don't guess
search_knowledge {query} greps the bundled operational docs (offline; works in readonly) and
returns agenticnets://docs/{topic} URIs: index · concepts · architecture · inscriptions · arcql ·
interpolation · emit · commands · tool-catalog · llm · scheduling · cost · tokens ·
troubleshooting · recipes · nethub · security.
Before hand-writing an inscription read docs/inscriptions; when something is broken read
docs/troubleshooting; when unsure, search first — the traps in these docs were all found the hard way.`;
}
