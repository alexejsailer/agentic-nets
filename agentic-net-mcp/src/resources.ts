/**
 * MCP resources — read surfaces and the knowledge base that teaches clients
 * how to use Agentic-Nets well (distilled from the agenticos-control plugin's
 * skill references and hard-won operating experience).
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { TEMPLATES } from './templates/index.js';
import { nativeCatalog } from './tools/catalog.js';

const DOCS: Record<string, { title: string; text: string }> = {
  concepts: {
    title: 'Agentic-Nets concepts',
    text: `# Concepts

Agentic-Nets extends Petri nets into a self-improving automation substrate:
- PLACES: persistent tree nodes (event-sourced) holding TOKENS (structured JSON with provenance).
- TRANSITIONS: seven kinds — pass (route), map (template transform), http (API call), llm (one AI
  inference), agent (multi-step autonomous AI), command (shell on a distributed executor), link
  (pure knowledge-graph edge; never fires).
- INSCRIPTIONS: a transition's runtime config — presets (input places + ArcQL binding), an action,
  emit rules routing the result, and an optional schedule (cron or interval).
- The net topology IS the architecture: adding capability = adding places and transitions.
- Scheduling makes nets ALIVE: a scheduled transition ticks server-side forever — this is what makes
  memory here different from passive stores; it can distill, consolidate, digest while you are away.
- Crystallization: patterns discovered by AI harden into deterministic tool-nets that replay at
  zero LLM cost (scaffold_tool_net / invoke_tool_net).

Template interpolation: \${input.data.field} reads the bound token; the root is the PRESET KEY.
Emit sources: @response (map/llm result), @response.json (http), @response.raw (llm raw), @result
(command), @input.data (passthrough). Every non-link inscription should have a catch-all emit —
unmatched results otherwise leave input tokens unconsumed (by design, to prevent data loss).`,
  },
  arcql: {
    title: 'ArcQL reference',
    text: `# ArcQL

Token query language used in presets and query_tokens.

FROM $                                  -- all tokens
FROM $ WHERE $.status=="active"         -- equality: DOUBLE equals, DOUBLE quotes
FROM $ WHERE $.amount > 100             -- numeric comparison
FROM $ WHERE $.a=="x" AND $.b=="y"      -- conjunction
FROM $ ORDER BY $.createdAt DESC LIMIT 5
FROM $ LIMIT 1                          -- the default preset binding

Paths always start with $. Common mistakes: single '=', single quotes, missing $ prefix.`,
  },
  recipes: {
    title: 'Recipes',
    text: `# Recipes

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

## Debugging a stuck lane
net_overview (statuses) -> query_tokens on the input place (token waiting? shape right?) ->
event_trail q:<transitionId> (what happened on last fire?) -> stop_transition, fire_once, start.

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

## Monitoring & debugging personas with NO logs or source
net_stats is the cockpit: which transitions are RUNNING vs stopped/error, what is scheduled, LLM
consumption per transition (calls/errors/avgMs for llm+agent fires), tool-net usage, and the most
recent error events. Then drill in: event_trail {q:"t-<name>-work"} for what a persona actually did;
query_tokens on its task/output places for the data; verify_inscription / dry_run_transition /
diagnose_transition on a stuck transition for a health report — all via the API, no container access.

## Overnight automation (cron / interval schedules)
Give any non-link transition a schedule and it ticks server-side with nobody connected:
- add_transition {kind:"llm", scheduleCron:"0 0 3 * * *", prompt:"Summarize yesterday's p-mem-inbox…"}
  = a 03:00 nightly digest. (6-field cron: sec min hour day month weekday.)
- spawn_persona {intervalMs:3600000, ...} = a persona that self-initiates hourly instead of waiting
  for tasks. set_schedule retrofits a schedule onto an existing transition.
Always tell the user what you armed (it will act — and possibly spend LLM — on its own), and check
net_stats.scheduled to see everything that will fire unattended.

## Spawning Claude Code workers from a net
A command transition can launch a full Claude Code instance on the executor host — a net that
delegates entire coding tasks to a fresh agent:
  add_transition {kind:"command", ...} consuming command-shaped tokens whose args.command is
  claude -p 'Fix the failing test in /repo/x' --allowedTools 'Read,Grep,Glob,Edit,Bash' --no-session-persistence < /dev/null
Rules: ALWAYS < /dev/null (stdin blocks forever otherwise); confine --allowedTools to least
privilege; timeoutMs in minutes; the executor host needs the claude CLI. This is how a persona can
"hire" a coding agent overnight — the net stays deterministic, the spawned agent does the fuzzy work.

## The kill switch (full model control)
pause_model stops EVERY running transition — zero fires, zero LLM spend, schedules frozen — and
records what was running as an audit token in p-mcp-control. resume_model restores exactly that
set. One lane: stop_transition / start_transition. The meter: net_stats (paused flag, llm.calls,
scheduled list). "Switch it off" => pause_model; verify with net_stats.paused==true.`,
  },
  security: {
    title: 'Scope & security model',
    text: `# Scope & security

This server enforces a MODEL ALLOWLIST in-process: every tool call is validated against
AGENTICOS_MODELS before anything reaches the backend; out-of-list models return
MODEL_NOT_ALLOWED. Readonly deployments authenticate with the gateway's readonly client — the
GATEWAY itself rejects mutations (403), and mutating tools are not even registered.

Honest boundary: the underlying gateway credential is not model-scoped (the platform has no
per-model authorization yet), so the allowlist protects against client/LLM mistakes and prompt
injection — not against a malicious operator of this process. Never ask for or echo secrets.

Readonly limitation: ArcQL queries travel as POST, which the gateway's readonly scope rejects —
plain-substring memory_recall and query_tokens WITHOUT an arcql argument work fine in readonly
(they use GET endpoints); pass ArcQL only in rw mode.`,
  },
};

export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    'models',
    'agenticnets://models',
    { title: 'Allowed models', description: 'The model allowlist, default model, and mode', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            { allowed: ctx.scope.allowed, default: ctx.scope.defaultModel, mode: ctx.config.mode, session: ctx.config.session },
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'templates',
    'agenticnets://templates',
    { title: 'Starter templates', description: 'Deployable templates with their parameters', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            Object.values(TEMPLATES).map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              params: t.params ?? {},
              tags: t.tags ?? [],
            })),
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'tool-catalog',
    'agenticnets://tool-catalog',
    {
      title: 'Native tool catalog',
      description: 'Every platform-native tool exposed by this server (UPPERCASE names — same catalog agent transitions use in-net)',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            nativeCatalog().map((t) => ({
              name: t.name,
              description: t.description,
              params: Object.keys(t.input_schema?.properties ?? {}),
              required: t.input_schema?.required ?? [],
            })),
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'hub',
    'agenticnets://hub',
    { title: 'NetHub — local catalog + remotes', description: 'Published artifacts on this instance and the registered peer remotes', mimeType: 'application/json' },
    async (uri) => {
      const [catalog, remotes] = await Promise.all([
        ctx.master.hubCatalog().catch(() => ({ note: 'hub catalog unavailable' })),
        ctx.master.hubListRemotes().catch(() => ({ remotes: [] })),
      ]);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ catalog, remotes }, null, 1) }] };
    },
  );

  server.registerResource(
    'tool-nets',
    'agenticnets://tool-nets',
    { title: 'Tool-net library', description: 'Reusable tool-nets you can invoke_tool_net', mimeType: 'application/json' },
    async (uri) => {
      const res = await ctx.executorFor(ctx.scope.defaultModel).execute('LIST_TOOL_NETS', {}).catch(() => null);
      const data = res?.success ? res.data : { note: 'no tool-nets found or library unavailable', tools: [] };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 1) }] };
    },
  );

  server.registerResource(
    'docs',
    new ResourceTemplate('agenticnets://docs/{topic}', {
      list: async () => ({
        resources: Object.entries(DOCS).map(([topic, d]) => ({
          uri: `agenticnets://docs/${topic}`,
          name: d.title,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: 'Agentic-Nets knowledge base', description: 'concepts | arcql | recipes | security' },
    async (uri, { topic }) => {
      const doc = DOCS[String(topic)];
      if (!doc) throw new Error(`unknown doc topic '${topic}' (have: ${Object.keys(DOCS).join(', ')})`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.text }] };
    },
  );
}
