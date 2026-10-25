/**
 * Named abstraction levels of a model (Explorer levels document): list them, or save the whole
 * ordered list. A level may be locked (a level-specific access policy): the master then refuses
 * changes to the nets on it, builds included, until the level is unlocked here.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { StructuredToolError, wrapTool } from '../scope.js';
import { explorerPath, masterCall } from './definitions.js';

const levelSchema = z.object({
  id: z.string().describe('Stable id, e.g. "product"'),
  name: z.string().optional(),
  description: z.string().optional(),
  locked: z.boolean().optional().describe('Refuse changes to the nets on this level until unlocked'),
  lockNote: z.string().optional(),
});

export function registerLevelTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  if (config.mode === 'readonly') return;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'net_levels',
    {
      title: 'Abstraction levels of a model',
      description:
        'The named levels of the hierarchy, top to bottom (order follows the list). action:"list" returns them; '
        + 'action:"save" REPLACES the whole list (read first, then send the full list). Nets are placed on a level with '
        + 'update_net_definition {action:"organize", layer}; without a level a net sits at its subnet depth. '
        + 'locked:true is a level policy: the master refuses organize, relate and builds for nets on that level '
        + '(code level-locked) until it is saved unlocked. Designtime only.',
      inputSchema: {
        action: z.enum(['list', 'save']).default('list').describe('list (default) or save'),
        levels: z.array(levelSchema).optional().describe('save: the complete ordered list'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'net_levels', mutates: true }, async (model, args) => {
      if (args.action === 'list') {
        const listed = await masterCall(ctx, 'GET', explorerPath(model, '/levels'));
        return { action: 'list', model, levels: Array.isArray(listed?.levels) ? listed.levels : [] };
      }
      if (!Array.isArray(args.levels)) {
        throw new StructuredToolError({ code: 'missing-field', error: 'save needs the complete levels list' });
      }
      const levels = args.levels.map((l: any, order: number) => ({ ...l, order }));
      const saved = await masterCall(ctx, 'PUT', explorerPath(model, '/levels'), { levels });
      return { action: 'save', model, levels: Array.isArray(saved?.levels) ? saved.levels : levels };
    }),
  );
}
