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
  | "FIND_NET_NEIGHBORS"
  | "TAG_SESSION"
  | "LIST_SESSIONS_BY_TAG"
  | "LIST_TOOL_NETS"
  | "DESCRIBE_TOOL_NET"
  | "REGISTER_TOOL_NET"
  | "INVOKE_TOOL_NET"
  | "SCAFFOLD_TOOL_NET";

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
  TAG_SESSION: {
    description: "Set/add/remove tags on a session. Tags live as a JSON string array on /root/workspace/sessions/{sessionId}/tags. Convention: tag tool-sessions with 'tools' so agents can discover them.",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string", description: "Session identifier. Falls back to the agent's session context if omitted." },
        tags: { type: "array", description: "Tag names to apply." },
        mode: { type: "string", description: "'set' replaces all tags, 'add' appends (deduped), 'remove' subtracts. Default 'add'." }
      },
      required: ["tags"],
    },
  },
  LIST_SESSIONS_BY_TAG: {
    description: "List sessions whose tags intersect any of the provided tags. Use as the FIRST step when discovering tool-nets: call with tags=['tools'] to find the tool-sessions in this model.",
    schema: {
      type: 'object',
      properties: {
        tags: { type: "array", description: "Match any of these tags. Empty list returns every tagged session." },
        tag: { type: "string", description: "Convenience shorthand for a single tag (alternative to 'tags')." }
      },
      required: [],
    },
  },
  LIST_TOOL_NETS: {
    description: "Discover reusable tool nets. Defaults to scanning sessions tagged 'tools'. Preferred starting point when a user asks for a capability that might already exist.",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string", description: "Scope to one session. If omitted, scans every session matching the tag filter." },
        tag: { type: "string", description: "Session tag to scan. Defaults to 'tools'." },
        query: { type: "string", description: "Case-insensitive substring match against tool name, description, and tags." }
      },
      required: [],
    },
  },
  DESCRIBE_TOOL_NET: {
    description: "Full manifest for a single tool net. REQUIRED before INVOKE_TOOL_NET — you need the input schema to build a valid input token.",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string", description: "Session holding the tool net." },
        netId: { type: "string", description: "Tool-net identifier." }
      },
      required: ["sessionId", "netId"],
    },
  },
  REGISTER_TOOL_NET: {
    description: "Tag an existing net as a tool: writes a tool-manifest leaf and tags its session (default 'tools'). Use when you manually designed a reusable net and want agents to discover it.",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string" },
        netId: { type: "string" },
        manifest: { type: "object", description: "Full ToolManifest: { name, version?, description, tags?, trigger: { placeId, transitionId, mode?, inputSchema }, result: { placeId, outputSchema, correlationField? }, examples?, status? }" },
        sessionTag: { type: "string", description: "Tag to apply to the session (default 'tools')." }
      },
      required: ["sessionId", "netId", "manifest"],
    },
  },
  INVOKE_TOOL_NET: {
    description: "Synchronously call a tool net: writes an input token with a correlation id, fires the trigger transition, polls the result place filtered on the correlation id, consumes the result token, and returns its data. The tool net MUST propagate the correlation field from input to output (default '_correlationId'). Max invocation depth: 5.",
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: "string", description: "Session holding the tool net." },
        netId: { type: "string", description: "Tool-net identifier." },
        input: { type: "object", description: "Input payload matching manifest.trigger.inputSchema." },
        timeoutMs: { type: "integer", description: "Polling timeout (default 30000)." }
      },
      required: ["sessionId", "netId"],
    },
  },
  SCAFFOLD_TOOL_NET: {
    description: "Create a new tool-net skeleton in a 'tools'-tagged session: net container, input/output places, trigger transition, arcs, runtime places, and tool-manifest leaf. Does NOT create the inscription — follow with SET_INSCRIPTION on the returned transitionId. Emit template must echo the correlation field from input to output.",
    schema: {
      type: 'object',
      properties: {
        toolSessionId: { type: "string", description: "Target session. Defaults to 'tools'. Created and tagged automatically if missing." },
        name: { type: "string", description: "Short tool name (e.g., 'weather-fetch')." },
        description: { type: "string", description: "One-sentence description of what the tool does." },
        tags: { type: "array", description: "Descriptive tags embedded in the manifest (not session tags)." },
        inputSchema: { type: "object", description: "JSON Schema for the input token." },
        outputSchema: { type: "object", description: "JSON Schema for the output token." }
      },
      required: ["name"],
    },
  },
};
