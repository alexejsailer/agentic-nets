/**
 * Observability layer — read-only windows into a model. These three tools are
 * the full registration set in readonly mode (plus memory_recall/memory_graph).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { fetchTokens } from './memory.js';

export function registerObserveTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'net_overview',
    {
      title: 'Net / session overview',
      description:
        'Structure + live execution status. With netId: that net (places, transitions, arcs, statuses). Without: an overview of every net in the MCP session.',
      inputSchema: {
        netId: z.string().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'net_overview', mutates: false }, async (model, args) => {
      const executor = ctx.executorFor(model);
      const res = args.netId
        ? await executor.execute('GET_NET_OVERVIEW', { netId: args.netId, sessionId: config.session })
        : await executor.execute('GET_SESSION_OVERVIEW', { sessionId: config.session });
      if (!res.success) throw new Error(res.error ?? 'overview failed');
      return res.data;
    }),
  );

  server.registerTool(
    'query_tokens',
    {
      title: 'Query tokens in a place',
      description:
        'Read tokens from any runtime place with ArcQL. Paths: bare place id (resolved under root/workspace/places) or a full node path. ArcQL: FROM $ [WHERE $.field=="value"] [ORDER BY $.f DESC] [LIMIT n] — note == and double quotes.',
      inputSchema: {
        place: z.string().describe('Place id or full path'),
        arcql: z.string().optional().describe('Default: FROM $ LIMIT 100'),
        fields: z.array(z.string()).optional().describe('Project only these token fields'),
        maxValueLength: z.number().optional().describe('Truncate long values (default 500 when no fields projection)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'query_tokens', mutates: false }, async (model, args) => {
      // Without ArcQL, use the GET runtime endpoint — works under the gateway's
      // readonly scope too (ArcQL travels as POST, which readonly rejects).
      if (!args.arcql && !String(args.place).includes('/')) {
        const tokens = await fetchTokens(ctx, model, args.place);
        return { place: args.place, resultCount: tokens.length, results: tokens };
      }
      const placePath = String(args.place).includes('/') ? args.place : `root/workspace/places/${args.place}`;
      const res = await ctx.executorFor(model).execute('QUERY_TOKENS', {
        placePath,
        query: args.arcql ?? 'FROM $ LIMIT 100',
        ...(args.fields ? { fields: args.fields } : {}),
        ...(args.maxValueLength != null ? { maxValueLength: args.maxValueLength } : {}),
      });
      if (!res.success) throw new Error(res.error ?? 'QUERY_TOKENS failed');
      return res.data;
    }),
  );

  server.registerTool(
    'event_trail',
    {
      title: 'Event trail (audit log)',
      description:
        'The model event line — why a token exists, what a transition did, in order. Filter by free text, correlationId, category or status. This is how you audit memory and debug nets.',
      inputSchema: {
        q: z.string().optional().describe('Free-text filter'),
        correlationId: z.string().optional(),
        category: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().optional().describe('Default 50'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'event_trail', mutates: false }, async (model, args) => {
      const query: Record<string, string> = { limit: String(args.limit ?? 50) };
      for (const k of ['q', 'correlationId', 'category', 'status'] as const) {
        if (args[k] != null && args[k] !== '') query[k] = String(args[k]);
      }
      return ctx.client.masterApi('GET', `/event-line/${model}`, undefined, query);
    }),
  );
}
