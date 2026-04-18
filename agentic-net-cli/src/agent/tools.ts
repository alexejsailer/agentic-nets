/**
 * Agent tools ported from AgentTool.java.
 * Each tool maps to a gateway API call.
 */
export type AgentTool =
  // Planning / Reasoning
  | 'THINK'
  // Token Operations
  | 'QUERY_TOKENS'
  | 'CREATE_TOKEN'
  | 'DELETE_TOKEN'
  // Place Operations
  | 'LIST_PLACES'
  | 'GET_PLACE_INFO'
  | 'GET_PLACE_CONNECTIONS'
  // Transition Operations
  | 'GET_TRANSITION'
  | 'VERIFY_RUNTIME_BINDINGS'
  // Net Structure
  | 'GET_NET_STRUCTURE'
  | 'VERIFY_NET'
  | 'EXPORT_PNML'
  | 'NET_DOCTOR'
  | 'ADAPT_INSCRIPTIONS'
  // Runtime Place Operations (W flag)
  | 'CREATE_RUNTIME_PLACE'
  // Structure Creation (W flag)
  | 'CREATE_SESSION'
  | 'CREATE_NET'
  | 'DELETE_NET'
  | 'CREATE_PLACE'
  | 'CREATE_TRANSITION'
  | 'CREATE_ARC'
  | 'DELETE_PLACE'
  | 'DELETE_ARC'
  | 'SET_INSCRIPTION'
  // External
  | 'HTTP_CALL'
  // Discovery
  | 'LIST_ALL_SESSIONS'
  | 'LIST_ALL_INSCRIPTIONS'
  | 'LIST_SESSION_NETS'
  | 'EMIT_MEMORY'
  | 'EXTRACT_TOKEN_CONTENT'
  | 'EXTRACT_RAW_DATA'
  | 'INSPECT_TOKEN_SIZE'
  | 'GET_LINKED_PLACES'
  // Package Registry (R/W flag)
  | 'PACKAGE_SEARCH'
  | 'PACKAGE_PUBLISH'
  | 'PACKAGE_INSTALL'
  // Registry Discovery (R flag)
  | 'REGISTRY_LIST_IMAGES'
  | 'REGISTRY_GET_IMAGE_INFO'
  // Docker Lifecycle (X flag)
  | 'DOCKER_RUN'
  | 'DOCKER_STOP'
  | 'DOCKER_LIST'
  | 'DOCKER_LOGS'
  // Dry Run (R flag)
  | 'DRY_RUN_TRANSITION'
  // Validation (R flag)
  | 'VERIFY_INSCRIPTION'
  | 'DIAGNOSE_TRANSITION'
  // Execute (X flag)
  | 'DEPLOY_TRANSITION'
  | 'START_TRANSITION'
  | 'STOP_TRANSITION'
  | 'FIRE_ONCE'
  | 'EXECUTE_TRANSITION'
  | 'EXECUTE_TRANSITION_SMART'
  // Discovery
  | 'FIND_SHARED_PLACES'
  // Hierarchical Overview (R flag — session/net/neighbor drill-down in one call)
  | 'GET_SESSION_OVERVIEW'
  | 'GET_NET_OVERVIEW'
  | 'FIND_NET_NEIGHBORS'
  // Session tags + tool-net discovery / authorship / invocation
  | 'TAG_SESSION'
  | 'LIST_SESSIONS_BY_TAG'
  | 'LIST_TOOL_NETS'
  | 'DESCRIBE_TOOL_NET'
  | 'REGISTER_TOOL_NET'
  | 'INVOKE_TOOL_NET'
  | 'SCAFFOLD_TOOL_NET'
  // Control
  | 'DONE'
  | 'FAIL';

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

/** Build Anthropic-compatible tool schemas for a set of tools. */
export function buildToolSchemas(tools: Set<AgentTool>): ToolSchema[] {
  const schemas: ToolSchema[] = [];
  for (const tool of tools) {
    const def = TOOL_DEFINITIONS[tool];
    if (def) {
      schemas.push({
        name: tool,
        description: def.description,
        input_schema: def.schema,
      });
    }
  }
  return schemas;
}

export interface ToolDef {
  description: string;
  schema: { type: 'object'; properties: Record<string, any>; required: string[] };
}

import { GENERATED_TOOL_DEFINITIONS } from './tools.generated.js';

const TOOL_DEFINITIONS: Record<AgentTool, ToolDef> = {
  // Hand-written tool definitions below. Tools defined in the master catalog
  // (agent-tool-catalog.json) are spread in from GENERATED_TOOL_DEFINITIONS at
  // the end of this object so the catalog is the single source of truth for
  // those entries. See scripts/sync-tool-schemas.ts to regenerate.
  THINK: {
    description: 'Deep planning checkpoint. Reason about the current state, plan next steps, identify risks.',
    schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you are trying to achieve' },
        plan: { type: 'string', description: 'Step-by-step plan' },
        risks: { type: 'string', description: 'Potential risks or issues' },
        successCriteria: { type: 'string', description: 'How to verify success' },
      },
      required: ['goal', 'plan'],
    },
  },
  QUERY_TOKENS: {
    description: 'Query tokens from a place using ArcQL. Long values auto-truncated to 500 chars unless overridden.',
    schema: {
      type: 'object',
      properties: {
        placePath: { type: 'string', description: 'Path to the place (e.g., root/workspace/places/my-place)' },
        query: { type: 'string', description: 'ArcQL query (e.g., FROM $ WHERE $.status=="active" LIMIT 10)' },
        arcql: { type: 'string', description: 'Alias for query' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Only return these fields (e.g., ["url","status"])' },
        maxValueLength: { type: 'number', description: 'Truncate string values longer than N chars (default 500)' },
      },
      required: ['placePath'],
    },
  },
  CREATE_TOKEN: {
    description: 'Create a token in a RUNTIME place with JSON data (usually under root/workspace/places/{placeId}). WARNING: First call GET_PLACE_CONNECTIONS to check for consuming transitions — it returns expectedTokenShape per consumer showing requiredFields. Command transitions require full CommandToken schema: {kind:"command",id:"...",executor:"bash",command:"exec",args:{command:"..."},expect:"text"}. Do NOT FIRE_ONCE on running transitions. Token name auto-generated if omitted.',
    schema: {
      type: 'object',
      properties: {
        placePath: { type: 'string', description: 'Path to the place' },
        name: { type: 'string', description: 'Token name (auto-generated if omitted)' },
        tokenName: { type: 'string', description: 'Alias for name' },
        data: { type: 'object', description: 'Token data as JSON object' },
        tokenData: { type: 'object', description: 'Alias for data' },
      },
      required: ['placePath'],
    },
  },
  DELETE_TOKEN: {
    description: 'Delete a token from a place by name or ID. Provide tokenName OR tokenId (from _meta.id in QUERY_TOKENS results). To delete by ID: QUERY_TOKENS first, extract `_meta.id`, then DELETE_TOKEN({placePath, tokenId: "uuid"}).',
    schema: {
      type: 'object',
      properties: {
        placePath: { type: 'string', description: 'Path to the place containing the token' },
        tokenName: { type: 'string', description: 'Name of the token to delete (use this OR tokenId)' },
        tokenId: { type: 'string', description: 'UUID of the token from _meta.id (use this OR tokenName)' },
      },
      required: ['placePath'],
    },
  },
  CREATE_RUNTIME_PLACE: {
    description: 'Create a runtime place (token container) at root/workspace/places/{placeId}. Required before tokens can be created in or emitted to a new place. Idempotent — safe to call if place already exists.',
    schema: {
      type: 'object',
      properties: {
        placeId: { type: 'string', description: 'Place ID (e.g., p-enriched-html)' },
      },
      required: ['placeId'],
    },
  },
  LIST_PLACES: {
    description: 'List all runtime places in the model with token counts.',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  GET_PLACE_INFO: {
    description: 'Get metadata about a specific place including token count.',
    schema: {
      type: 'object',
      properties: {
        placePath: { type: 'string', description: 'Path to the place' },
      },
      required: ['placePath'],
    },
  },
  GET_PLACE_CONNECTIONS: {
    description: 'Discover which transitions consume from or produce to a given place. Returns expectedTokenShape per consumer with requiredFields and templateVars. Call BEFORE CREATE_TOKEN to know exactly which fields your token must include.',
    schema: {
      type: 'object',
      properties: {
        placeId: { type: 'string', description: 'Place ID to check (e.g., p-source-inbox)' },
      },
      required: ['placeId'],
    },
  },
  GET_TRANSITION: {
    description: 'Read a transition\'s inscription configuration.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID' },
      },
      required: ['transitionId'],
    },
  },
  VERIFY_RUNTIME_BINDINGS: {
    description: 'Preflight check: verify all preset/postset runtime places referenced by a transition inscription exist under root/workspace/places. Use before DEPLOY_TRANSITION, START_TRANSITION, FIRE_ONCE, and EXECUTE_TRANSITION.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID' },
      },
      required: ['transitionId'],
    },
  },
  GET_NET_STRUCTURE: {
    description: 'Get full Petri net PNML structure.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID to retrieve' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId'],
    },
  },
  VERIFY_NET: {
    description: 'Verify net structure: check for duplicates, orphans, consistency.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID to verify' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId'],
    },
  },
  EXPORT_PNML: {
    description: 'Export a net as clean PNML JSON with coordinates.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID to export' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId'],
    },
  },
  NET_DOCTOR: {
    description: 'Diagnose visual PNML vs runtime inscription drift for a net and optionally auto-fix arcs to match runtime bindings.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID to analyze' },
        sessionId: { type: 'string', description: 'Session ID (optional, defaults to current session)' },
        applyFixes: { type: 'boolean', description: 'If true, apply proposed arc fixes (delete bad/duplicate arcs, add missing arcs)' },
      },
      required: ['netId'],
    },
  },
  ADAPT_INSCRIPTIONS: {
    description: 'Adapt inscription presets/postsets to match arc-connected places and validate NL expressions. Reports and optionally fixes placeId drift.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID to check' },
        sessionId: { type: 'string', description: 'Session ID (optional)' },
        applyFixes: { type: 'boolean', description: 'If true, auto-fix inscription placeIds to match arcs' },
      },
      required: ['netId'],
    },
  },
  CREATE_SESSION: {
    description: 'Create a new session in the model workspace with optional NL text.',
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID (e.g., examples, session-2026-03-04)' },
        naturalLanguageText: { type: 'string', description: 'Initial NL description for the session' },
        description: { type: 'string', description: 'Optional short description' },
      },
      required: ['sessionId'],
    },
  },
  CREATE_NET: {
    description: 'Create a new Petri net container in a session.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID' },
        name: { type: 'string', description: 'Human-readable name' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId'],
    },
  },
  DELETE_NET: {
    description: 'Delete a net from the session.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID to delete' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId'],
    },
  },
  CREATE_PLACE: {
    description: 'Create a VISUAL PNML place in a net (design-time only, not a runtime token container).',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID' },
        placeId: { type: 'string', description: 'Place ID (e.g., p-input)' },
        label: { type: 'string', description: 'Display label' },
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        tokens: { type: 'number', description: 'Initial token count' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId', 'placeId'],
    },
  },
  CREATE_TRANSITION: {
    description: 'Create a new transition in a net.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID' },
        transitionId: { type: 'string', description: 'Transition ID (e.g., t-process)' },
        label: { type: 'string', description: 'Display label' },
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId', 'transitionId'],
    },
  },
  CREATE_ARC: {
    description: 'Create an arc connecting a place and transition.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID' },
        arcId: { type: 'string', description: 'Arc ID' },
        sourceId: { type: 'string', description: 'Source element ID (place or transition)' },
        targetId: { type: 'string', description: 'Target element ID (place or transition)' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId', 'sourceId', 'targetId'],
    },
  },
  DELETE_PLACE: {
    description: 'Delete a place from a net.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID' },
        placeId: { type: 'string', description: 'Place ID to delete' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId', 'placeId'],
    },
  },
  DELETE_ARC: {
    description: 'Delete an arc from a net.',
    schema: {
      type: 'object',
      properties: {
        netId: { type: 'string', description: 'Net ID' },
        arcId: { type: 'string', description: 'Arc ID to delete' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['netId', 'arcId'],
    },
  },
  SET_INSCRIPTION: {
    description: 'Set runtime inscription configuration for a transition. Supports optional schedule: {type: "interval", intervalMs: N} or {type: "cron", cron: "expr"}.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID' },
        inscription: { type: 'object', description: 'Full TransitionInscription JSON (id, kind, presets, postsets, action, emit, mode, schedule?)' },
      },
      required: ['transitionId', 'inscription'],
    },
  },
  HTTP_CALL: {
    description: 'Make an external HTTP request.',
    schema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE)' },
        url: { type: 'string', description: 'Target URL' },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'object', description: 'Request body' },
      },
      required: ['method', 'url'],
    },
  },
  LIST_ALL_SESSIONS: {
    description: 'List all sessions in the model.',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  LIST_ALL_INSCRIPTIONS: {
    description: 'List all transition inscriptions. Use kind filter to find examples before creating new inscriptions.',
    schema: {
      type: 'object',
      properties: {
        includeContent: { type: 'boolean', description: 'Include full inscription content' },
        kind: { type: 'string', description: 'Filter by kind: http, command, agent, map, task, llm' },
        limit: { type: 'number', description: 'Max results (default 3 when kind is set)' },
      },
      required: [],
    },
  },
  LIST_SESSION_NETS: {
    description: 'List all workspace-nets in a session.',
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },
  EMIT_MEMORY: {
    description: 'Write knowledge to the configured memory place.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Memory token name' },
        data: { type: 'object', description: 'Knowledge data' },
      },
      required: ['name', 'data'],
    },
  },
  EXTRACT_TOKEN_CONTENT: {
    description: 'Extract and analyze a single token\'s large content (e.g. 70KB HTML). Modes: auto (recommended — smart detect+strip), summarize, text, links, structure, head.',
    schema: {
      type: 'object',
      properties: {
        placePath: { type: 'string', description: 'Path to the place containing the token' },
        tokenName: { type: 'string', description: 'Exact name of the token to read' },
        mode: { type: 'string', description: 'Processing mode: auto (recommended), summarize, text, links, structure, head' },
        property: { type: 'string', description: 'Which token property to read (default: body)' },
        limit: { type: 'number', description: 'Max chars for text/head modes (default: 4000)' },
      },
      required: ['placePath', 'tokenName'],
    },
  },
  EXTRACT_RAW_DATA: {
    description: 'Extract plain text values from tokens in a place, stripping JSON structure for compact readable output. Values auto-truncated to 2000 chars.',
    schema: {
      type: 'object',
      properties: {
        placePath: { type: 'string', description: 'Path to the place' },
        query: { type: 'string', description: 'ArcQL query (default: FROM $)' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Which properties to extract (default: all)' },
        separator: { type: 'string', description: 'Separator between values (default: newline)' },
        maxLength: { type: 'number', description: 'Max total output chars (default: 8000)' },
        maxValueLength: { type: 'number', description: 'Max chars per value before truncation (default: 2000)' },
      },
      required: ['placePath'],
    },
  },
  INSPECT_TOKEN_SIZE: {
    description: 'Measure token content sizes (bytes, words, chars, content type) WITHOUT reading actual content. Call BEFORE QUERY_TOKENS for web-crawled or large content. Returns per-token readingHint (SMALL/MEDIUM/LARGE).',
    schema: {
      type: 'object',
      properties: {
        placePath: { type: 'string', description: 'Path to the place' },
        arcql: { type: 'string', description: 'ArcQL query (default: FROM $ LIMIT 20)' },
      },
      required: ['placePath'],
    },
  },
  GET_LINKED_PLACES: {
    description: 'Navigate link transitions to discover connected places in a knowledge graph. Returns places reachable from a given place via link-type transitions.',
    schema: {
      type: 'object',
      properties: {
        placeId: { type: 'string', description: 'Starting place ID' },
        depth: { type: 'number', description: 'Max traversal depth (default: 1)' },
      },
      required: ['placeId'],
    },
  },
  FIND_SHARED_PLACES: {
    description: 'Find places that appear in multiple nets (shared places). Returns each shared place with the nets it belongs to and current token count. Use this to understand cross-net communication topology.',
    schema: {
      type: 'object',
      properties: {
        namePattern: { type: 'string', description: "Optional glob pattern to filter place names (e.g., 'p-*', 'p-knowledge-*'). Defaults to all places." },
      },
      required: [],
    },
  },
  PACKAGE_SEARCH: {
    description: 'Search the package registry for published Agentic-Net packages.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        tags: { type: 'string', description: 'Filter by tags (comma-separated)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: [],
    },
  },
  PACKAGE_PUBLISH: {
    description: 'Package and publish a workspace-net as a versioned artifact to the registry.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Package name' },
        version: { type: 'string', description: 'Semantic version (e.g., 1.0.0)' },
        netId: { type: 'string', description: 'Net ID to publish' },
        sessionId: { type: 'string', description: 'Session containing the net' },
        description: { type: 'string', description: 'Package description' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for discovery' },
      },
      required: ['name', 'version', 'netId'],
    },
  },
  PACKAGE_INSTALL: {
    description: 'Import a published package into the current session.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Package name' },
        version: { type: 'string', description: 'Package version' },
        targetSessionId: { type: 'string', description: 'Session to install into' },
      },
      required: ['name', 'version'],
    },
  },
  DEPLOY_TRANSITION: {
    description: 'Deploy a transition to the executor for execution.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to deploy' },
        inscription: { type: 'object', description: 'TransitionInscription JSON' },
      },
      required: ['transitionId'],
    },
  },
  START_TRANSITION: {
    description: 'Start a deployed transition.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to start' },
      },
      required: ['transitionId'],
    },
  },
  STOP_TRANSITION: {
    description: 'Stop a running transition.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to stop' },
      },
      required: ['transitionId'],
    },
  },
  FIRE_ONCE: {
    description: 'Fire a transition once on master synchronously and return results. Use only for deterministic transitions (pass/map/http/command), not agent/llm transitions.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to fire' },
      },
      required: ['transitionId'],
    },
  },
  EXECUTE_TRANSITION: {
    description: 'Execute an agent/llm transition locally using your own LLM provider. For agent actions it runs a bounded sub-agent loop; for llm actions it runs a direct local LLM call with emit-rule routing. Local execution must produce postset tokens explicitly; no auto-summary token emission.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to execute (must be an agent or llm transition)' },
        maxIterations: { type: 'number', description: 'Maximum sub-agent iterations (default 8, hard-capped at 12)' },
      },
      required: ['transitionId'],
    },
  },
  EXECUTE_TRANSITION_SMART: {
    description: 'Smart transition execution router. In auto mode, agent/llm transitions execute locally in CLI/Telegram LLM; deterministic transitions (pass/map/http/command) use FIRE_ONCE on master. Use this as the default "execute transition" tool.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to execute' },
        mode: { type: 'string', description: 'Execution mode: auto (default), local, or master. master is invalid for action.type=agent|llm.' },
        maxIterations: { type: 'number', description: 'Maximum local iterations for agent transitions (default 8, hard cap 12)' },
      },
      required: ['transitionId'],
    },
  },
  REGISTRY_LIST_IMAGES: {
    description: 'List available tool images from the OCI registry. Use to discover what tool containers can be deployed.',
    schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter images by name (e.g., "pdf")' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  REGISTRY_GET_IMAGE_INFO: {
    description: 'Get detailed info about a tool image including capabilities, port, health endpoint, and OpenAPI spec path.',
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Image repository name (e.g., "agenticos-tool-pdf")' },
        tag: { type: 'string', description: 'Image tag (default "latest")' },
      },
      required: ['image'],
    },
  },
  DOCKER_RUN: {
    description: 'Start a tool container from a registry image. Returns the container\'s endpoint URL for use in HTTP transition actions.',
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Full image reference (e.g., "localhost:5001/agenticos-tool-pdf:1.0.0")' },
        name: { type: 'string', description: 'Short name for the container (will be prefixed with agenticos-tool-)' },
        env: { type: 'object', description: 'Environment variables as key-value pairs' },
        sessionId: { type: 'string', description: 'Session ID to associate with the container' },
      },
      required: ['image'],
    },
  },
  DOCKER_STOP: {
    description: 'Stop a running tool container.',
    schema: {
      type: 'object',
      properties: {
        containerId: { type: 'string', description: 'Container ID' },
        name: { type: 'string', description: 'Container name' },
      },
      required: [],
    },
  },
  DOCKER_LIST: {
    description: 'List running AgenticNetOS tool containers.',
    schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by name/image/tool label' },
      },
      required: [],
    },
  },
  DOCKER_LOGS: {
    description: 'Get logs from a tool container for debugging.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
        containerId: { type: 'string', description: 'Container ID' },
        tail: { type: 'number', description: 'Number of log lines (default 50)' },
      },
      required: [],
    },
  },
  DRY_RUN_TRANSITION: {
    description: 'Dry-run a single transition: gathers upstream/downstream context, simulates action output in-memory (MAP template, HTTP URL, command token), and validates pipeline format compatibility. Use before FIRE_ONCE to catch mismatches.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to dry-run' },
      },
      required: ['transitionId'],
    },
  },
  VERIFY_INSCRIPTION: {
    description: 'Algorithmically verify inscription: schema, ArcQL syntax, action config, emit rules, net context, and token compatibility — deterministic PASS/FAIL.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to verify' },
      },
      required: ['transitionId'],
    },
  },
  DIAGNOSE_TRANSITION: {
    description: 'Diagnose transition health: validates inscription, checks runtime bindings, verifies executor assignment, and runs pipeline compatibility — returns single holistic report with actionable recommendations.',
    schema: {
      type: 'object',
      properties: {
        transitionId: { type: 'string', description: 'Transition ID to diagnose' },
      },
      required: ['transitionId'],
    },
  },
  DONE: {
    description: 'Signal successful completion of the task.',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what was accomplished' },
      },
      required: ['summary'],
    },
  },
  FAIL: {
    description: 'Signal failure with an error message.',
    schema: {
      type: 'object',
      properties: {
        error: { type: 'string', description: 'Error description' },
        attempted: { type: 'string', description: 'What was attempted' },
      },
      required: ['error'],
    },
  },
  // --- Generated from agent-tool-catalog.json ---
  ...GENERATED_TOOL_DEFINITIONS,
};
