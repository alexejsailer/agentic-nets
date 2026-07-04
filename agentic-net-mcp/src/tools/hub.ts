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
        'Browse published artifacts — local by default, or a peer instance when the remote param names a registered remote. Filter by kind (net|session|model), free-text search, and tags. Returns a compact list plus the true total; page with offset when more exist.',
      inputSchema: {
        kind: z.enum(['net', 'session', 'model']).optional(),
        search: z.string().optional(),
        tags: z.string().optional().describe('Comma-separated'),
        remote: z.string().optional().describe('A registered remote to browse instead of local'),
        limit: z.number().int().positive().max(200).optional().describe('Max results per page (default 25)'),
        offset: z.number().int().nonnegative().optional().describe('Skip N results — page through a large catalog'),
      },
    },
    wrapTool(scope, config.mode, { name: 'hub_search', mutates: false }, async (_model, args) => {
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const raw = args.remote
        ? await ctx.master.hubRemoteCatalog(args.remote, { kind: args.kind, search: args.search, tags: args.tags, limit, offset })
        : await ctx.master.hubCatalog({ kind: args.kind, search: args.search, tags: args.tags, limit, offset });

      const artifacts: any[] = Array.isArray(raw?.artifacts) ? raw.artifacts : [];
      const total: number = typeof raw?.total === 'number' ? raw.total : artifacts.length;
      const compact = artifacts.map((a) => ({
        name: a.name,
        version: a.latestVersion ?? a.version,
        kind: a.kind ?? 'net',
        visibility: a.visibility ?? 'public',
        description: a.description || undefined,
        tags: Array.isArray(a.tags) && a.tags.length ? a.tags : undefined,
      }));

      const out: Record<string, unknown> = {
        source: args.remote ? `remote:${args.remote}` : 'local',
        total,
        returned: compact.length,
        offset,
        artifacts: compact,
      };
      const seen = offset + compact.length;
      if (total > seen) {
        out.more = `+${total - seen} more — page with offset=${seen}`;
      }
      if (compact.length === 0) {
        out.hint = 'No artifacts match. Try hub_search with no filters, or a different kind/search.';
      }
      return out;
    }),
  );

  server.registerTool(
    'hub_show',
    {
      title: 'Inspect a NetHub artifact before installing',
      description:
        'Show one artifact in detail so you can decide whether to install it: all published versions, kind, visibility, token policy, description, readme, tags, origin, size, and a shape summary (nodes/nets/tokens). Local registry only.',
      inputSchema: {
        name: z.string(),
        version: z.string().optional().describe('Version or "latest" (default latest)'),
      },
    },
    wrapTool(scope, config.mode, { name: 'hub_show', mutates: false }, async (_model, args) => {
      const versionsResp = await ctx.master.hubVersions(args.name);
      const versions: string[] = Array.isArray(versionsResp?.versions) ? versionsResp.versions : [];
      const pkg = await ctx.master.hubArtifact(args.name, args.version ?? 'latest');

      const m = pkg?.manifest ?? {};
      const kind = pkg?.kind ?? (Array.isArray(pkg?.nets) ? 'session' : pkg?.model ? 'model' : 'net');
      const visibility = pkg?.visibility ?? (pkg?.public === false ? 'private' : 'public');

      const countNodes = (n: any): number => {
        if (!n || typeof n !== 'object') return 0;
        let c = 1;
        if (Array.isArray(n.children)) for (const ch of n.children) c += countNodes(ch);
        return c;
      };
      const tokenCount = (t: any): number =>
        t && typeof t === 'object'
          ? Object.values(t).reduce((s: number, a: any) => s + (Array.isArray(a) ? a.length : 0), 0)
          : 0;

      const shape: Record<string, number> = {};
      if (pkg?.model?.root) shape.modelNodes = countNodes(pkg.model.root);
      if (Array.isArray(pkg?.nets)) shape.nets = pkg.nets.length;
      const tk = tokenCount(pkg?.tokens);
      if (tk) shape.tokens = tk;

      let sizeBytes = 0;
      try { sizeBytes = Buffer.byteLength(JSON.stringify(pkg), 'utf8'); } catch { /* ignore */ }

      return {
        name: args.name,
        version: m.version ?? args.version ?? versions[versions.length - 1],
        kind,
        visibility,
        tokenPolicy: pkg?.tokenPolicy ?? pkg?.tokens ?? 'unknown',
        description: m.description || pkg?.description || undefined,
        readme: pkg?.readme || m.readme || undefined, // readme is a top-level package field
        tags: Array.isArray(m.tags) && m.tags.length ? m.tags : undefined,
        author: m.author || undefined,
        createdAt: m.createdAt || undefined,
        origin: pkg?.origin || undefined,
        sizeBytes,
        versions,
        shape: Object.keys(shape).length ? shape : undefined,
      };
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
