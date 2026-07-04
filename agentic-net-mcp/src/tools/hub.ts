/**
 * NetHub curated tools — publish/discover/install net·session·model artifacts across instances,
 * on top of master's /api/hub. The ergonomic layer over the native HUB_* catalog tools:
 * sensible defaults (source = the bound model, tokens = config), a single hub_search that
 * spans local + a named remote, and grantModel() on a model install so the new model is
 * immediately targetable (mirrors create_model).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { grantModel } from '../scope.js';

export function registerHubTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Source/target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'hub_publish',
    {
      title: 'Publish a NetHub artifact',
      description:
        'Publish a net, session, or whole model as a versioned, shareable artifact. tokens controls what data ships: "none" = structure + inscriptions only; "config" (default) = also tokens in *-config/*-charter places or marked config; "all" = everything. visibility "public" (default) is what peers can discover when the hub public catalog is enabled; "private" stays local. Credentials are always scrubbed.',
      inputSchema: {
        kind: z.enum(['net', 'session', 'model']).describe('What to publish'),
        name: z.string(),
        version: z.string().describe('Semantic version, e.g. 1.0.0'),
        netId: z.string().optional().describe('Required for kind=net'),
        sessionId: z.string().optional().describe('Required for kind=net/session (default: the MCP session)'),
        tokens: z.enum(['none', 'config', 'all']).optional().describe('Token export policy (default config)'),
        configPlaces: z.array(z.string()).optional().describe('Override config-token place globs/ids (default *-config,*-charter)'),
        visibility: z.enum(['public', 'private']).optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        readme: z.string().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'hub_publish', mutates: true }, async (model, args) => {
      return ctx.master.hubPublish({
        kind: args.kind,
        name: args.name,
        version: args.version,
        description: args.description,
        tags: args.tags,
        readme: args.readme,
        visibility: args.visibility,
        tokens: args.tokens,
        configPlaces: args.configPlaces,
        source: { modelId: model, sessionId: args.sessionId ?? config.session, netId: args.netId },
      });
    }),
  );

  server.registerTool(
    'hub_search',
    {
      title: 'Search the NetHub catalog',
      description:
        'Browse published artifacts — local by default, or a peer instance when `remote` names a registered remote. Filter by kind (net|session|model), free-text search, and tags.',
      inputSchema: {
        kind: z.enum(['net', 'session', 'model']).optional(),
        search: z.string().optional(),
        tags: z.string().optional().describe('Comma-separated'),
        remote: z.string().optional().describe('A registered remote to browse instead of local'),
      },
    },
    wrapTool(scope, config.mode, { name: 'hub_search', mutates: false }, async (_model, args) => {
      const opts = { kind: args.kind, search: args.search, tags: args.tags };
      return args.remote ? ctx.master.hubRemoteCatalog(args.remote, opts) : ctx.master.hubCatalog(opts);
    }),
  );

  server.registerTool(
    'hub_install',
    {
      title: 'Install a NetHub artifact',
      description:
        'Install an artifact into this stack. source "local" (default) or a registered remote name; remote installs download, re-scrub, and keep a provenance copy locally. Model artifacts create a NEW model (targetModelId required; mode CREATE_NEW default, REPLACE to overwrite) and it joins this connection\'s allowlist immediately. Net/session artifacts import into targetSessionId.',
      inputSchema: {
        name: z.string(),
        version: z.string().describe('Version or "latest"'),
        source: z.string().optional().describe('local (default) or a registered remote name'),
        targetModelId: z.string().optional().describe('Target model (REQUIRED for kind=model — use a fresh id)'),
        targetSessionId: z.string().optional(),
        mode: z.enum(['CREATE_NEW', 'REPLACE']).optional().describe('model-kind only (default CREATE_NEW)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'hub_install', mutates: true }, async (model, args) => {
      const res = await ctx.master.hubInstall({
        source: args.source,
        name: args.name,
        version: args.version,
        targetModelId: args.targetModelId ?? model,
        targetSessionId: args.targetSessionId ?? config.session,
        mode: args.mode,
      });
      // A freshly installed model must be immediately targetable via the `model` param.
      if (res?.kind === 'model' && res?.targetModelId) {
        grantModel(scope, res.targetModelId);
      }
      return res;
    }),
  );

  server.registerTool(
    'hub_add_remote',
    {
      title: 'Add a NetHub remote',
      description:
        "Register a peer AgenticOS instance's base URL so you can hub_search and hub_install its PUBLIC artifacts. The peer must have its public catalog enabled (AGENTICOS_HUB_PUBLIC_CATALOG=true).",
      inputSchema: {
        name: z.string().describe('Short remote name, e.g. "team-alpha"'),
        url: z.string().describe('Absolute base URL, e.g. https://alpha.example.com:8083'),
      },
    },
    wrapTool(scope, config.mode, { name: 'hub_add_remote', mutates: true }, async (_model, args) => {
      return ctx.master.hubAddRemote(args.name, args.url);
    }),
  );
}
