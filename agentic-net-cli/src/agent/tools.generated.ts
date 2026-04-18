/**
 * AUTO-GENERATED from core/agentic-net-master/src/main/resources/agent-tool-catalog.json
 *
 * Run `npm run sync-tools` to regenerate from the master catalog.
 * Edit the JSON file, not this TypeScript — changes here will be overwritten.
 */
import type { ToolDef } from './tools.js';

type GeneratedToolName =
  | "GET_SESSION_OVERVIEW"
  | "GET_NET_OVERVIEW"
  | "FIND_NET_NEIGHBORS";

export const GENERATED_TOOL_DEFINITIONS: Record<GeneratedToolName, ToolDef> = {
  GET_SESSION_OVERVIEW: {
    description: "Compact per-session summary: nets with place/transition/arc counts, session-local shared-place summary, transition-kind breakdown. Use as the FIRST call when exploring a session — replaces chaining LIST_SESSION_NETS + per-net GET_NET_STRUCTURE + FIND_SHARED_PLACES.",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string", description: "Session identifier (e.g., 'main', '2025-10-23_17-53-06'). Falls back to the agent's session context if omitted." }
      },
      required: [],
    },
  },
  GET_NET_OVERVIEW: {
    description: "Compact per-net summary: counts, transition-kind breakdown, shared-place cross-references to sibling nets, and link transitions with their source/target places. Lighter than GET_NET_STRUCTURE.",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string", description: "Session identifier. Falls back to the agent's session context if omitted." },
        netId: { type: "string", description: "Net identifier (e.g., 'ingest', or a timestamp container id)." }
      },
      required: ["netId"],
    },
  },
  FIND_NET_NEIGHBORS: {
    description: "BFS from a root net to find coupled sibling nets. Returns neighbors with hop count and reasons (e.g., 'shared:p-observations', 'link:t-route').",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string", description: "Session identifier. Falls back to the agent's session context if omitted." },
        netId: { type: "string", description: "Root net identifier — the BFS start." },
        depth: { type: "integer", description: "BFS depth, clamped to [1, 3]. Default 1." },
        via: { type: "string", description: "Coupling filter: 'shared' (shared places only), 'link' (link transitions only), or 'all' (default)." }
      },
      required: ["netId"],
    },
  },
};
