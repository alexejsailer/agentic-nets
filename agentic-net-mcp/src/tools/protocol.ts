/**
 * Protocol layer — a time-ordered operational journal for a model.
 *
 * Convention: `p-protocol` (a runtime place, auto-created on first write) holds
 * tokens `{kind:'protocol', ts, level, source, title, body?, tags?}`. Anything
 * can write it: this server via protocol_write, and nets by emitting to
 * `p-protocol` (add a postset + emit — no special API). Desktop Lite's Studio
 * renders the same place as the Protocol timeline (tray → Open Protocol), so a
 * milestone written here is immediately visible to the user.
 *
 * This is the local, self-contained sibling of the Memos reporting boards used
 * on server deployments: same habit — long-running work narrates itself — with
 * zero extra infrastructure.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { ensurePlace, fetchTokens, previewOf } from './memory.js';

export const PROTOCOL_PLACE = 'p-protocol';

function entryOf(token: any): Record<string, unknown> {
  const d = token?.data && Object.keys(token.data).length ? token.data : (token?.properties ?? token ?? {});
  return {
    ts: d.ts ?? d.createdAt ?? '',
    level: d.level ?? 'info',
    source: d.source ?? '',
    title: d.title ?? previewOf(token).slice(0, 120),
    ...(d.body ? { body: String(d.body).slice(0, 500) } : {}),
  };
}

function sortedEntries(tokens: any[], limit: number, level?: string): Record<string, unknown>[] {
  return tokens
    .map(entryOf)
    .filter((e) => !level || e.level === level)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, limit);
}

/** Read side only — GET-based, safe for readonly mode. */
export function registerProtocolReaders(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'protocol_tail',
    {
      title: 'Read the protocol journal',
      description:
        "The model's operational journal, newest first — milestones written by this server (protocol_write) and by nets emitting to p-protocol. The same feed Desktop Lite renders as the Studio Protocol view.",
      inputSchema: {
        limit: z.number().optional().describe('Max entries (default 30)'),
        level: z.enum(['info', 'warn', 'error']).optional().describe('Only entries of this level'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'protocol_tail', mutates: false }, async (model, args) => {
      const tokens = await fetchTokens(ctx, model, PROTOCOL_PLACE, 300).catch(() => []);
      const entries = sortedEntries(tokens, args.limit ?? 30, args.level);
      return { place: PROTOCOL_PLACE, count: entries.length, entries };
    }),
  );
}

export function registerProtocolTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'protocol_write',
    {
      title: 'Write a protocol entry',
      description:
        "Append a timestamped entry to the model's operational journal (place p-protocol). Use it to narrate milestones of long-running work — deployed a net, armed a schedule, finished a batch, hit an error — so the user can follow along in the Studio Protocol view without asking. Nets journal themselves by emitting to p-protocol.",
      inputSchema: {
        title: z.string().describe('One-line summary of what happened'),
        body: z.string().optional().describe('Detail — what, why, what happens next'),
        level: z.enum(['info', 'warn', 'error']).optional().describe('default info'),
        source: z.string().optional().describe('Who did it (default mcp; nets use their netId)'),
        tags: z.array(z.string()).optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'protocol_write', mutates: true }, async (model, args) => {
      await ensurePlace(ctx, model, PROTOCOL_PLACE);
      const data = {
        kind: 'protocol',
        title: args.title,
        ...(args.body ? { body: args.body } : {}),
        level: args.level ?? 'info',
        source: args.source ?? 'mcp',
        ...(args.tags?.length ? { tags: JSON.stringify(args.tags) } : {}),
        ts: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      const res = await ctx
        .executorFor(model)
        .execute('CREATE_TOKEN', { placePath: `root/workspace/places/${PROTOCOL_PLACE}`, data });
      if (!res.success) throw new Error(res.error ?? 'CREATE_TOKEN failed');
      return { logged: true, place: PROTOCOL_PLACE, ts: data.ts };
    }),
  );

  registerProtocolReaders(server, ctx);
}
