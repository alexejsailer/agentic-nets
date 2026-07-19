/**
 * Native tool catalog — FULL platform parity.
 *
 * Registers every tool the Agentic-Nets ToolExecutor implements (the same
 * catalog agent transitions use in-net) as a first-class MCP tool under its
 * canonical UPPERCASE name. The set and the schemas come straight from the
 * CLI's role registry (`getAvailableTools(FULL)` + `buildToolSchemas`), so new
 * platform tools appear here automatically on the next CLI sync — no MCP code
 * change needed.
 *
 * Division of labor with the curated lowercase tools: lowercase = the
 * ergonomic layer (pre-wired inscriptions, session fallbacks, engine gotchas
 * absorbed); UPPERCASE = raw native power (structure surgery, deletes,
 * packages, Docker/registry, NET_DOCTOR, exports, …). Same names as in-net
 * agent prompts, so knowledge transfers 1:1 between MCP clients and personas.
 *
 * Excluded: THINK / DONE / FAIL — agent-loop control primitives with no
 * meaning as stateless MCP calls. rw mode only: many native reads travel as
 * POST, which the readonly gateway scope rejects — readonly keeps the curated
 * GET-safe readers instead of advertising tools that would 403.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FULL, getAvailableTools } from '@agenticos/cli/agent/roles';
import { buildToolSchemas, type ToolSchema } from '@agenticos/cli/agent/tools';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

const AGENT_LOOP_ONLY = new Set(['THINK', 'DONE', 'FAIL']);

/**
 * Native tools that only READ (no state change) — drives truthful
 * readOnlyHint annotations instead of the old blanket mutates:true. Names not
 * matched here are treated as mutating (the safe default for an unknown tool).
 * TOOLNET_HEALTH is deliberately NOT read-only: active=true runs a live smoke
 * fire. COLLECT_RESULTS deletes correlated result tokens (self-cleaning).
 */
const READ_ONLY_NATIVE =
  /^(GET_|LIST_|QUERY_|DESCRIBE_|FIND_|INSPECT_|EXTRACT_|SEARCH_|EXPORT_|VERIFY_|DRY_RUN_|DIAGNOSE_|OBSERVE_|REGISTRY_|AWAIT_)/;
const READ_ONLY_EXTRA = new Set(['NET_DOCTOR', 'HUB_CATALOG', 'HUB_REMOTE_LIST', 'READ_BLOB_TEXT', 'TOOLNET_CANDIDATES', 'DOCKER_LIST', 'DOCKER_LOGS', 'TOOL_CATALOG_GET', 'TOOL_CATALOG_SEARCH', 'AGENT_HUB_SEARCH']);
/** Irreversible data removal — surfaces as destructiveHint via the annotation stamp. */
const DESTRUCTIVE_NATIVE = /^(DELETE_|HUB_UNPUBLISH)/;

export function isNativeReadOnly(name: string): boolean {
  return READ_ONLY_NATIVE.test(name) || READ_ONLY_EXTRA.has(name);
}

/**
 * Appended guidance for tools whose NAME or default output invites misreading
 * (protocol-hardening trap #5: a misleading name forecloses the search — the
 * description must point at the tool that actually answers the question).
 */
const DESCRIPTION_NOTES: Record<string, string> = {
  GET_SESSION_OVERVIEW:
    ' SCOPE WARNING: counts here are for ONE session, not the model — a fresh session reads netCount:0 even when the model is full. For the model-wide picture use net_overview (it adds modelSessionCount) or LIST_ALL_SESSIONS.',
  EXPORT_PNML:
    ' NOTE: designtime `tokens` counts in the export are FROZEN at design time (typically 0 forever) — they are NOT live marking. Read live tokens with query_tokens.',
  DEPLOY_TRANSITION:
    ' The response reports assigned:true and the resolved agentId — if no inscription is stored it fails loudly instead of "succeeding" without effect.',
};

/** The full native catalog as Anthropic-style schemas (name/description/input_schema). */
export function nativeCatalog(): ToolSchema[] {
  // Docker/registry tools (container spawning) are included by default for parity,
  // but deployments can withhold the grant with AGENTICOS_DOCKER_TOOLS=false —
  // mirroring the master's dedicated D capability flag instead of folding
  // container power into plain read/execute.
  const dockerGranted = process.env.AGENTICOS_DOCKER_TOOLS !== 'false';
  return buildToolSchemas(getAvailableTools({ ...FULL, docker: dockerGranted }))
    .filter((t) => !AGENT_LOOP_ONLY.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Shallow JSON-schema property → zod, keeping description + optionality (enough for discovery). */
function propToZod(prop: any, required: boolean): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  if (Array.isArray(prop?.enum) && prop.enum.length) {
    t = z.enum(prop.enum.map(String) as [string, ...string[]]);
  } else {
    switch (prop?.type) {
      case 'string':
        t = z.string();
        break;
      case 'integer':
      case 'number':
        t = z.number();
        break;
      case 'boolean':
        t = z.boolean();
        break;
      case 'array':
        t = z.array(z.any());
        break;
      case 'object':
        t = z.record(z.any());
        break;
      default:
        t = z.any();
    }
  }
  if (prop?.description) t = t.describe(String(prop.description));
  return required ? t : t.optional();
}

export function registerCatalogTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  if (config.mode === 'readonly') return;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  for (const tool of nativeCatalog()) {
    const shape: Record<string, z.ZodTypeAny> = { ...modelParam };
    const required = new Set(tool.input_schema?.required ?? []);
    // A native tool that declares its own `model` property (the tool-catalog scope param) has it
    // subsumed by the MCP scope param: the model the call routes to IS the catalog scope. Always
    // drop the native `model` from the advertised schema so it never appears twice (or at all in
    // single-model mode), and re-inject the resolved model as scope in the handler below.
    const declaresModelScope = 'model' in (tool.input_schema?.properties ?? {});
    const props = tool.input_schema?.properties ?? {};
    // Native token/place tools name their target `placePath`, but the ToolExecutor handler already
    // accepts `placeId`/`place` as aliases — and `placePath` actually wants the SHORT place id
    // (`p-input`), not a slash path. Advertise `placeId` and drop `placePath` from `required` so an
    // MCP caller can pass the same `placeId` the curated tools take, instead of being rejected by
    // schema validation before the handler's alias logic ever runs.
    const hasPlacePath = 'placePath' in props;
    if (hasPlacePath) required.delete('placePath');
    for (const [key, prop] of Object.entries(props)) {
      if (key === 'model') continue;
      shape[key] = propToZod(prop, required.has(key));
    }
    if (hasPlacePath && !('placeId' in props)) {
      shape.placeId = z
        .string()
        .optional()
        .describe('Alias for placePath — the short place id (e.g. p-input) works for either.');
    }
    server.registerTool(
      tool.name,
      {
        title: `${tool.name} (native)`,
        description: tool.description + (DESCRIPTION_NOTES[tool.name] ?? ''),
        inputSchema: shape,
      },
      wrapTool(
        scope,
        config.mode,
        { name: tool.name, mutates: !isNativeReadOnly(tool.name), destructive: DESTRUCTIVE_NATIVE.test(tool.name) },
        async (model, args) => {
        const { model: _m, ...params } = args ?? {};
        // Catalog-scope tools resolve local-first against the routed model.
        const res = await ctx.executorFor(model).execute(
          tool.name as any,
          declaresModelScope ? { ...params, model } : params,
        );
        if (!res.success) throw new Error(res.error ?? `${tool.name} failed`);
        return res.data ?? { ok: true };
      }),
    );
  }
}
