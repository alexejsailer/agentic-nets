/**
 * Protocol layer — a time-ordered operational journal for a model.
 *
 * Protocol is an ordinary installed application net. Its manifest maps the semantic
 * `entries` role to a place (the built-in/back-compatible mapping is `p-protocol`) and
 * declares `append`. Anything can write it through that action or by emitting to the
 * resolved place. Desktop Lite renders those same tokens as the Protocol timeline.
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
import { resolveApplicationStore } from './applications.js';

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
        "The model's net-backed operational journal, newest first. Resolves the installed Protocol application's entries role (falling back to legacy p-protocol during rolling upgrades). The same event-sourced tokens appear in Studio.",
      inputSchema: {
        limit: z.number().optional().describe('Max entries (default 30)'),
        level: z.enum(['info', 'warn', 'error']).optional().describe('Only entries of this level'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'protocol_tail', mutates: false }, async (model, args) => {
      const place = await resolveApplicationStore(ctx, model, 'protocol', 'entries', PROTOCOL_PLACE);
      const tokens = await fetchTokens(ctx, model, place, 300).catch(() => []);
      const entries = sortedEntries(tokens, args.limit ?? 30, args.level);
      return { application: 'protocol', role: 'entries', place, count: entries.length, entries };
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
        "Append a timestamped entry through the installed Protocol application's declared append action. Use it for meaningful milestones — deployed a net, armed a schedule, finished a batch, hit an error — so the user can follow Studio without asking. The built-in role remains p-protocol for backward compatibility.",
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
      try {
        const result: any = await ctx.client.masterApi(
          'POST',
          `/applications/${encodeURIComponent(model)}/protocol/actions/append`,
          data,
        );
        return { logged: true, application: 'protocol', role: 'entries', place: result?.placeId, ts: data.ts };
      } catch {
        // Rolling-upgrade compatibility: old masters have no application endpoint. Preserve the
        // original p-protocol behavior until the template-backed application is installed.
        await ensurePlace(ctx, model, PROTOCOL_PLACE);
        const res = await ctx
          .executorFor(model)
          .execute('CREATE_TOKEN', { placePath: `root/workspace/places/${PROTOCOL_PLACE}`, data });
        if (!res.success) throw new Error(res.error ?? 'CREATE_TOKEN failed');
        return { logged: true, application: 'protocol', role: 'entries', place: PROTOCOL_PLACE, ts: data.ts, compatibility: true };
      }
    }),
  );

  registerProtocolReaders(server, ctx);
}
