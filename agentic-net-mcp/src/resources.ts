/**
 * MCP resources — read surfaces and the knowledge base that teaches clients
 * how to use Agentic-Nets well (distilled from the agenticos-control plugin's
 * skill references and hard-won operating experience).
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { TEMPLATES } from './templates/index.js';

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
master handles correlation/fire/poll. Discover existing tool-nets via agenticnets://tool-nets.`,
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
