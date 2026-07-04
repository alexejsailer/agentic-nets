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

/** The full native catalog as Anthropic-style schemas (name/description/input_schema). */
export function nativeCatalog(): ToolSchema[] {
  return buildToolSchemas(getAvailableTools(FULL))
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
    for (const [key, prop] of Object.entries(tool.input_schema?.properties ?? {})) {
      if (key === 'model' && scope.multiModel) continue; // never let a native param shadow the scope param
      shape[key] = propToZod(prop, required.has(key));
    }
    server.registerTool(
      tool.name,
      {
        title: `${tool.name} (native)`,
        description: tool.description,
        inputSchema: shape,
      },
      wrapTool(scope, config.mode, { name: tool.name, mutates: true }, async (model, args) => {
        const { model: _m, ...params } = args ?? {};
        const res = await ctx.executorFor(model).execute(tool.name as any, params);
        if (!res.success) throw new Error(res.error ?? `${tool.name} failed`);
        return res.data ?? { ok: true };
      }),
    );
  }
}
