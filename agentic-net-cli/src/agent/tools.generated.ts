/**
 * AUTO-GENERATED from core/agentic-net-master/src/main/resources/agent-tool-catalog.json
 *
 * Run `npm run sync-tools` to regenerate from the master catalog.
 * Edit the JSON file, not this TypeScript — changes here will be overwritten.
 */
import type { ToolDef } from './tools.js';

type GeneratedToolName =
  | "CREATE_MODEL"
  | "LIST_MODELS"
  | "MEMORY_WRITE"
  | "GET_SESSION_OVERVIEW"
  | "GET_NET_OVERVIEW"
  | "FIND_NET_NEIGHBORS"
  | "TAG_SESSION"
  | "LIST_SESSIONS_BY_TAG"
  | "LIST_TOOL_NETS"
  | "DESCRIBE_TOOL_NET"
  | "REGISTER_TOOL_NET"
  | "INVOKE_TOOL_NET"
  | "SCAFFOLD_TOOL_NET"
  | "REGISTRY_LIST_IMAGES"
  | "REGISTRY_GET_IMAGE_INFO"
  | "DOCKER_RUN"
  | "DOCKER_STOP"
  | "DOCKER_LIST"
  | "DOCKER_LOGS"
  | "WRAP_DOCKER_TOOL"
  | "RUN_COMMAND"
  | "FOCUS_WORKSPACE"
  | "MEMORY_RECALL"
  | "STAT_BLOB"
  | "READ_BLOB_LINES"
  | "SEARCH_BLOB";

export const GENERATED_TOOL_DEFINITIONS: Record<GeneratedToolName, ToolDef> = {
  CREATE_MODEL: {
    description: "Create a new model (an isolated world with its own tree, sessions, places, and event line). Idempotent — succeeds if it already exists. To then work in it, call FOCUS_WORKSPACE action 'switch-model'.",
    schema: {
      type: 'object',
      properties: {
        modelId: { type: "string", description: "New model id. Letters, digits, '.', '_' or '-' only (no spaces or slashes)." },
        name: { type: "string", description: "Optional display name." },
        description: { type: "string", description: "Optional human description." }
      },
      required: ["modelId"],
    },
  },
  LIST_MODELS: {
    description: "List all available models (isolated worlds) by id. Use to find the target for FOCUS_WORKSPACE switch-model.",
    schema: {
      type: 'object',
      properties: {

      },
      required: [],
    },
  },
  MEMORY_WRITE: {
    description: "Persist a memory/knowledge item into this model's domain net (its durable memory base); builds the domain net if missing. Remember facts, decisions, and built tool nets so future turns and other agents recall them.",
    schema: {
      type: 'object',
      properties: {
        content: { type: ["string","object"], description: "The memory to store — a string or a structured object." },
        store: { type: "string", description: "knowledge (default) | journal | insights." },
        type: { type: "string", description: "Optional item type/category." },
        tags: { type: "array", description: "Optional tags for recall." }
      },
      required: ["content"],
    },
  },
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
    description: "Scaffold a reusable tool net (net container, input/output places, trigger, arcs, runtime places, tool-manifest) in a 'tools'-tagged session. transitionKind 'command' builds AND STARTS the build->run->shape pipeline that runs the input's `command` field on the executor and returns stdout/exitCode (INVOKE-green; no SET_INSCRIPTION/DEPLOY needed for command tools); 'http'/'llm' pre-wire that action; default passthrough is filled via SET_INSCRIPTION. Write an excellent, searchable description. Params: toolSessionId, name (required), description, tags, inputSchema, outputSchema, transitionKind.",
    schema: {
      type: 'object',
      properties: {
        toolSessionId: { type: "string", description: "Target session. Defaults to 'tools'. Created and tagged automatically if missing." },
        name: { type: "string", description: "Short tool name (e.g., 'weather-fetch')." },
        description: { type: "string", description: "One-sentence description of what the tool does." },
        tags: { type: "array", description: "Descriptive tags embedded in the manifest (not session tags)." },
        inputSchema: { type: "object", description: "JSON Schema for the input token." },
        outputSchema: { type: "object", description: "JSON Schema for the output token." },
        transitionKind: { type: "string", description: "'command'|'http'|'llm' — pre-wires the backing action. 'command' builds+starts the executor build->run->shape pipeline." },
        start: { type: "boolean", description: "Default true (auto-start, INVOKE-green). false builds a command pipeline PAUSED for a token-by-token demo." }
      },
      required: ["name"],
    },
  },
  REGISTRY_LIST_IMAGES: {
    description: "List available tool images from the OCI registry. Use to discover what tool containers can be deployed; follow with REGISTRY_GET_IMAGE_INFO, then DOCKER_RUN.",
    schema: {
      type: 'object',
      properties: {
        search: { type: "string", description: "Filter images by name (e.g., \"pdf\")" },
        limit: { type: "number", description: "Max results (default 20)" }
      },
      required: [],
    },
  },
  REGISTRY_GET_IMAGE_INFO: {
    description: "Get detailed info about a tool image including capabilities, port, health endpoint, and OpenAPI spec path. Param is image (repository name), NOT repository.",
    schema: {
      type: 'object',
      properties: {
        image: { type: "string", description: "Image repository name (e.g., \"agenticos-tool-pdf\")" },
        tag: { type: "string", description: "Image tag (default \"latest\")" }
      },
      required: ["image"],
    },
  },
  DOCKER_RUN: {
    description: "Start a tool container from a registry image. Returns baseUrl (current instance), svcUrl (STABLE svc://tool/<name> address — use THIS in http transition urls, it follows the tool across restarts), ready (health check passed), and openapiUrl when the tool describes its endpoints.",
    schema: {
      type: 'object',
      properties: {
        image: { type: "string", description: "Full image reference (e.g., \"localhost:5001/agenticos-tool-pdf:1.0.0\")" },
        name: { type: "string", description: "Short logical name (e.g. \"crawler\"). Keys the stable svc://tool/<name> address; container name gets an agenticos-tool- prefix and a random suffix." },
        env: { type: "object", description: "Environment variables as key-value pairs" },
        sessionId: { type: "string", description: "Session ID to associate with the container" },
        hostPort: { type: "number", description: "Publish the tool on this host port (needed when master runs natively, outside the docker network)" }
      },
      required: ["image"],
    },
  },
  DOCKER_STOP: {
    description: "Stop a running tool container. Pass name OR containerId (from DOCKER_RUN/DOCKER_LIST).",
    schema: {
      type: 'object',
      properties: {
        containerId: { type: "string", description: "Container ID" },
        name: { type: "string", description: "Container name" }
      },
      required: [],
    },
  },
  DOCKER_LIST: {
    description: "List running AgenticNetOS tool containers.",
    schema: {
      type: 'object',
      properties: {
        filter: { type: "string", description: "Filter by name/image/tool label" }
      },
      required: [],
    },
  },
  DOCKER_LOGS: {
    description: "Get logs from a tool container for debugging. Pass name OR containerId.",
    schema: {
      type: 'object',
      properties: {
        name: { type: "string", description: "Container name" },
        containerId: { type: "string", description: "Container ID" },
        tail: { type: "number", description: "Number of log lines (default 50)" }
      },
      required: [],
    },
  },
  WRAP_DOCKER_TOOL: {
    description: "Wrap a docker tool image into invocable tool-nets: ensures the container is running, reads its OpenAPI spec, and registers one tool-net per operation (e.g. crawler.crawl). Then call operations with INVOKE_TOOL_NET — the backing container is re-started automatically on every invocation. Prefer this over hand-building HTTP transitions against containers.",
    schema: {
      type: 'object',
      properties: {
        image: { type: "string", description: "Image reference (e.g. \"agenticos-tool-crawler\" or full registry ref)" },
        name: { type: "string", description: "Logical tool name (defaults to repo short name); prefixes the generated tool-net names" },
        sessionId: { type: "string", description: "Tool-net session (default \"tools\")" }
      },
      required: ["image"],
    },
  },
  RUN_COMMAND: {
    description: "Run a shell command on the connected executor synchronously and get the result. Huge output is offloaded to a blob (stdoutUrn) — analyze with STAT_BLOB/READ_BLOB_LINES/SEARCH_BLOB. Runs via a reusable 'shell-runner' command tool-net (built once, reused). Genesis-dedicated.",
    schema: {
      type: 'object',
      properties: {
        command: { type: "string", description: "Shell command to run on the executor." },
        workingDir: { type: "string", description: "Optional working directory on the executor host." },
        timeoutMs: { type: "integer", description: "Optional command timeout in ms (default 60000)." }
      },
      required: ["command"],
    },
  },
  FOCUS_WORKSPACE: {
    description: "Control the Genesis live workspace view: tell the GUI which net to open and which place/transition to zoom to, so the user sees what you are working on. action: 'open' (show the net) | 'focus' (zoom+select an element in the shown net) | 'close' (remove it) | 'reset' (clear the view). Call it whenever you create, change, inspect, or finish a net — INCLUDING after a delegated build (the child's work is invisible to the GUI otherwise) — to keep the visible workspace aligned with your work. This is a view hint only; it never changes net data.",
    schema: {
      type: 'object',
      properties: {
        action: { type: "string", description: "open (show the net) | focus (zoom+select an element in the shown net) | close (remove it) | reset (clear the view). Default open." },
        netId: { type: "string", description: "Net to show/focus in the live workspace (required for open/focus)." },
        sessionId: { type: "string", description: "Session holding the net (defaults to the agent's session)." },
        elementId: { type: "string", description: "Optional place/transition id to select and zoom to." },
        note: { type: "string", description: "Optional short caption shown in the workspace strip, e.g. 'wiring the HTTP call'." }
      },
      required: [],
    },
  },
  MEMORY_RECALL: {
    description: "Recall memory/knowledge items stored in this model's domain net (its memory base), newest first. Call before acting on something that may have been handled before.",
    schema: {
      type: 'object',
      properties: {
        store: { type: "string", description: "knowledge (default) | journal | insights." },
        query: { type: "string", description: "Optional ArcQL filter (e.g. FROM $ WHERE $.type==\"decision\")." },
        limit: { type: "integer", description: "Max items (default 10)." }
      },
      required: [],
    },
  },
  STAT_BLOB: {
    description: "Get a blob's size (bytes) and content-type WITHOUT downloading it (HEAD). Use first to size a large blob (e.g. a command result's stdoutUrn) before READ_BLOB_LINES / SEARCH_BLOB.",
    schema: {
      type: 'object',
      properties: {
        blobUrn: { type: "string", description: "Blob URN, e.g. urn:agenticos:blob:..." }
      },
      required: ["blobUrn"],
    },
  },
  READ_BLOB_LINES: {
    description: "Read a line range of a text blob. Page through large output instead of dumping it all.",
    schema: {
      type: 'object',
      properties: {
        blobUrn: { type: "string", description: "Blob URN." },
        offset: { type: "integer", description: "First line, 0-based (default 0)." },
        limit: { type: "integer", description: "Max lines to return (default 200)." }
      },
      required: ["blobUrn"],
    },
  },
  SEARCH_BLOB: {
    description: "Grep a text blob with a regex, returning line-numbered matches with surrounding context.",
    schema: {
      type: 'object',
      properties: {
        blobUrn: { type: "string", description: "Blob URN." },
        pattern: { type: "string", description: "Java regex to search for." },
        contextLines: { type: "integer", description: "Lines of context each side (default 2)." },
        maxMatches: { type: "integer", description: "Max matches returned (default 50)." },
        ignoreCase: { type: "boolean", description: "Case-insensitive (default true)." }
      },
      required: ["blobUrn", "pattern"],
    },
  },
};
