/**
 * Net-backed application discovery. Applications are ordinary installed session nets whose
 * optional manifest maps semantic roles/actions to places and selects a Studio renderer.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

async function list(ctx: AppContext, model: string): Promise<any[]> {
  const result: any = await ctx.client.masterApi(
    'GET',
    `/applications/${encodeURIComponent(model)}`,
  );
  return Array.isArray(result) ? result : [];
}

async function describe(ctx: AppContext, model: string, name: string): Promise<any> {
  return ctx.client.masterApi(
    'GET',
    `/applications/${encodeURIComponent(model)}/${encodeURIComponent(name)}`,
  );
}

export async function resolveApplicationStore(
  ctx: AppContext,
  model: string,
  application: string,
  role: string,
  fallback?: string,
): Promise<string> {
  try {
    const app = await describe(ctx, model, application);
    const store = Array.isArray(app?.stores)
      ? app.stores.find((candidate: any) => candidate?.role === role)
      : undefined;
    return store?.placeId || fallback || '';
  } catch {
    return fallback || '';
  }
}

export function registerApplicationReaders(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'application_list',
    {
      title: 'List installed net applications',
      description:
        'Discover user-facing capabilities backed by ordinary nets. Returns each application\'s semantic store roles, declared actions, and Studio surface. Check this before hardcoding a place: Protocol, Interview, Goals, or a domain-specific application may already be installed.',
      inputSchema: { ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'application_list', mutates: false }, async (model) => ({
      model,
      applications: await list(ctx, model),
      guidance:
        'Use application_describe before acting. Declared actions resolve semantic roles to the installed net places; the same tokens are visible in Studio and the event trail.',
    })),
  );

  server.registerTool(
    'application_describe',
    {
      title: 'Describe a net application',
      description:
        'Inspect one installed application net: stores (role → placeId), JSON-shaped actions, and its Studio renderer. This is the machine-readable playbook personas use to interact without hidden platform conventions.',
      inputSchema: {
        name: z.string().describe('Application name, e.g. protocol, interview, goals'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'application_describe', mutates: false }, async (model, args) =>
      describe(ctx, model, args.name),
    ),
  );
}

export function registerApplicationTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'application_action',
    {
      title: 'Act through an installed application net',
      description:
        'Execute a manifest-declared append action on an ordinary application net. Master resolves targetRole to its installed place, validates required input, creates an event-sourced token, and Studio renders the same state. Examples: protocol/append, goals/set, goals/report-progress, and the two-way Interview surface — interview/ask (options as strings or {value,label,description,recommended}, multiSelect, allowFreeText, supersedes, batchId), interview/respond (intent answer|revise|reject, selected, text, notes, revisedQuestion), interview/raise (a question the HUMAN asks you). Poll the interview requests store and re-ask with supersedes when a response carries intent:"revise".',
      inputSchema: {
        name: z.string().describe('Installed application name'),
        action: z.string().describe('Action declared by application_describe'),
        input: z.record(z.any()).describe('Payload matching the action inputSchema'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'application_action', mutates: true }, async (model, args) =>
      ctx.client.masterApi(
        'POST',
        `/applications/${encodeURIComponent(model)}/${encodeURIComponent(args.name)}/actions/${encodeURIComponent(args.action)}`,
        args.input,
      ),
    ),
  );

  registerApplicationReaders(server, ctx);
}
