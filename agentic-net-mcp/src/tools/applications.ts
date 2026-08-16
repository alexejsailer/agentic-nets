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

/**
 * Derive each store's write contract from the actions that target it (field finding V2-5:
 * action defaults like kind stamps apply ONLY on the application_action path — a net lane
 * writing directly into an application place bypasses them, the store declares no schema,
 * and the renderer silently degrades or drops the token). This makes the expected shape
 * queryable so direct writers can conform.
 */
function withStoreContracts(app: any): any {
  if (!app || !Array.isArray(app.stores)) return app;
  const actions: any[] = Array.isArray(app.actions) ? app.actions : [];
  const stores = app.stores.map((store: any) => {
    const writers = actions.filter((a: any) => a?.targetRole === store?.role);
    const kinds = [...new Set(writers.map((a: any) => a?.defaults?.kind).filter(Boolean))];
    const requiredFields = [...new Set(writers.flatMap((a: any) =>
      Array.isArray(a?.inputSchema?.required) ? a.inputSchema.required : []))];
    if (!kinds.length && !requiredFields.length) return store;
    return {
      ...store,
      writeContract: {
        ...(kinds.length ? { expectedKind: kinds.length === 1 ? kinds[0] : kinds } : {}),
        ...(requiredFields.length ? { correlationFields: requiredFields } : {}),
        note: 'Derived from the actions targeting this store. A net lane emitting DIRECTLY into '
          + 'this place bypasses action defaults — carry at least the expected kind and the '
          + 'correlation fields, or the renderer may silently degrade/drop the token.',
      },
    };
  });
  return { ...app, stores };
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
        'Inspect one installed application net: stores (role → placeId), JSON-shaped actions, optional agentProtocol, and its Studio renderer. This is the machine-readable playbook personas use to interact without hidden platform conventions.',
      inputSchema: {
        name: z.string().describe('Application name, e.g. protocol, interview, goals'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'application_describe', mutates: false }, async (model, args) =>
      withStoreContracts(await describe(ctx, model, args.name)),
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
        'Execute a manifest-declared action on an ordinary application net. Master resolves targetRole, validates required input and optional correlated-token guards, appends an event-sourced token, and applies declared correlated updates. Studio renders the same state. Examples: protocol/append; goals/set/report-progress; Interview ask/respond/raise; Persona Kanban createTask/claimTask/addComment/requestReview/approveTask. Read agentProtocol before working a task application.',
      inputSchema: {
        name: z.string().describe('Installed application name'),
        action: z.string().describe('Action declared by application_describe'),
        input: z.record(z.any()).describe('Payload matching the action inputSchema'),
        idempotencyKey: z.string().max(200).optional()
          .describe('Stable retry key; reuse only for the exact same action input.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'application_action', mutates: true }, async (model, args) =>
      ctx.client.masterApi(
        'POST',
        `/applications/${encodeURIComponent(model)}/${encodeURIComponent(args.name)}/actions/${encodeURIComponent(args.action)}`,
        args.input,
        args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined,
      ),
    ),
  );

  registerApplicationReaders(server, ctx);
}
