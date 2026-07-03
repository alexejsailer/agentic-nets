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
  call, http=API call, command=shell via executor, link=pure structure edge). Transitions you
  schedule (scheduleCron/intervalMs) keep running server-side after you disconnect.
- Crystallize: when you have a working pattern, scaffold_tool_net once, then invoke_tool_net
  forever — deterministic replay at zero LLM cost.
- Audit and debug: net_overview -> query_tokens on suspect places -> event_trail (every token has
  a provenance trail — use it to answer "why does memory say X").

## Rules that save you from real engine gotchas
1. ArcQL: double equals and double quotes — FROM $ WHERE $.status=="active" LIMIT 5. Paths start with $.
2. \${input.data.field} in prompts/templates interpolates the INPUT TOKEN's fields; the root name
   is the preset key (default 'input').
3. link transitions NEVER fire — they are navigable edges only. Never start them.
4. A capacity-N output place blocks its producer when full (backpressure, not an error).
5. fire_once returns 409 while a transition is RUNNING — stop_transition first, fire, start again.
6. assign/set_schedule stops a transition; the tools here restart it for you — but remember it if
   you work the REST API directly.
7. Prefer deterministic kinds (map/http) wherever possible; use llm transitions only where judgment
   is genuinely needed — that is what makes nets cheap and reliable.

Read agenticnets://docs/concepts for the full model, agenticnets://docs/recipes for patterns.`;
}
