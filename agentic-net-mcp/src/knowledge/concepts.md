# Concepts

Agentic-Nets extends Petri nets into a self-improving automation substrate:
- PLACES: persistent tree nodes (event-sourced) holding TOKENS (structured JSON with provenance).
- TRANSITIONS: seven kinds — pass (route), map (template transform), http (API call), llm (one AI
  inference), agent (multi-step autonomous AI), command (shell on a distributed executor), link
  (pure knowledge-graph edge; never fires).
- INSCRIPTIONS: a transition's runtime config — presets (input places + ArcQL binding), an action,
  emit rules routing the result, and an optional schedule (cron or interval).
- EXECUTORS: a stack can run several command executors; a command transition picks its executor via
  action.executorId ('*' = any executor, first token reservation wins; omitted =
  agentic-net-executor-default). Discover them with list_executors.
- The net topology IS the architecture: adding capability = adding places and transitions.
- Scheduling makes nets ALIVE: a scheduled transition ticks server-side forever — this is what makes
  memory here different from passive stores; it can distill, consolidate, digest while you are away.
- Crystallization: patterns discovered by AI harden into deterministic tool-nets that replay at
  zero LLM cost (scaffold_tool_net / invoke_tool_net).

## Picking a transition kind

Deterministic first: if a step CAN be a map/http/pass, never make it llm/agent. Reach for llm only
when judgment over content is required, and for agent only when the work is multi-step with tool
use. Deterministic kinds are free, instant, and can't hallucinate. See docs/inscriptions for the
per-kind templates and docs/llm for the llm/agent failure modes.

## Where things live

- Design-time net (what the GUI draws): sessions/{sessionId}/workspace-nets/{netId}/pnml/net
- Runtime places (where tokens actually flow): root/workspace/places/{placeId}
- Runtime transitions (inscription + status): root/workspace/transitions/{transitionId}
These are TWO layers — see docs/architecture for the rule that inscriptions bind RUNTIME places.

Template interpolation: ${input.data.field} reads the bound token; the root is the PRESET KEY
(docs/interpolation). Emit sources: @response (map/llm result), @response.json (http),
@response.raw (llm raw text — freeform only), @result (command), @input.data (passthrough). Every non-link inscription
should have a catch-all emit — unmatched results otherwise leave input tokens unconsumed (by
design, to prevent data loss; docs/emit).
