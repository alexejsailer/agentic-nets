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

  server.registerTool(
    'net_stats',
    {
      title: 'Model statistics — LLM usage, running transitions, tool-nets',
      description:
        'Aggregated operational stats for a model, computed with NO log-file or source access. Reports: which transitions are RUNNING vs STOPPED/ERROR (+ a paused flag when nothing runs); which transitions carry a SCHEDULE (cron/interval — i.e. what will fire overnight on its own); LLM consumption (llm + agent transition fires — calls, errors, avg duration, per transition) derived from the event line; overall activity by kind; the most recent error events; and the tool-net library. This is how you answer "what is consuming LLM / what is running / what will run while I sleep / what just broke".',
      inputSchema: {
        window: z.number().optional().describe('How many recent events to aggregate for LLM/activity stats (default 500)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'net_stats', mutates: false }, async (model, args) => {
      const window = args.window ?? 500;
      const [txRes, evRes, tnRes, insRes] = await Promise.all([
        ctx.client.masterApi('GET', '/runtime/transitions', undefined, { modelId: model }).catch(() => null),
        ctx.client.masterApi('GET', `/event-line/${model}`, undefined, { limit: String(window) }).catch(() => null),
        ctx.executorFor(model).execute('LIST_TOOL_NETS', {}).catch(() => null),
        ctx.executorFor(model).execute('LIST_ALL_INSCRIPTIONS', { includeContent: true }).catch(() => null),
      ]);

      // --- transitions + live statuses (shape-tolerant across master versions) ---
      const txList: any[] = Array.isArray(txRes) ? txRes : (txRes?.transitions ?? txRes?.results ?? txRes?.data ?? []);
      const byStatus: Record<string, number> = {};
      const running: string[] = [];
      const notRunning: any[] = [];
      for (const t of txList) {
        const id = t.transitionId ?? t.id ?? t.name ?? '?';
        const status = String(t.status ?? t.state ?? (t.running ? 'RUNNING' : 'STOPPED')).toUpperCase();
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        if (status === 'RUNNING') running.push(id);
        else notRunning.push({ transitionId: id, status, ...(t.kind ? { kind: t.kind } : {}) });
      }

      // --- LLM consumption + activity + recent errors from the event line ---
      const events: any[] = evRes?.events ?? [];
      const perTx = new Map<string, { transitionId: string; kind: string; calls: number; errors: number; totalMs: number }>();
      const activityByKind: Record<string, number> = {};
      const recentErrors: any[] = [];
      let fires = 0;
      let fireErrors = 0;
      for (const e of events) {
        const st = String(e.status ?? '').toLowerCase();
        if ((st === 'error' || st === 'failed') && recentErrors.length < 15) {
          recentErrors.push({ seq: e.seq, ts: e.ts, category: e.category, type: e.type, summary: String(e.summary ?? '').slice(0, 200) });
        }
        if (e.category !== 'transition' || e.type !== 'fire') continue;
        fires++;
        const kind = String(e.attributes?.kind ?? 'unknown');
        activityByKind[kind] = (activityByKind[kind] ?? 0) + 1;
        const isErr = st !== 'success';
        if (isErr) fireErrors++;
        const tid = String(e.attributes?.transitionId ?? '?');
        const ms = Number(e.attributes?.durationMs ?? 0) || 0;
        const cur = perTx.get(tid) ?? { transitionId: tid, kind, calls: 0, errors: 0, totalMs: 0 };
        cur.calls++;
        cur.totalMs += ms;
        if (isErr) cur.errors++;
        perTx.set(tid, cur);
      }
      const llmTx = [...perTx.values()].filter((t) => t.kind === 'llm' || t.kind === 'agent');
      const byTransition = llmTx
        .map((t) => ({ transitionId: t.transitionId, kind: t.kind, calls: t.calls, errors: t.errors, avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0 }))
        .sort((a, b) => b.calls - a.calls);

      // --- scheduled transitions: the "what runs overnight on its own" answer ---
      const insList: any[] = insRes?.success ? (insRes.data?.transitions ?? []) : [];
      const scheduled = insList
        .filter((t) => t.inscription?.schedule)
        .map((t) => ({
          transitionId: t.transitionId,
          kind: t.inscription.kind,
          schedule: t.inscription.schedule,
          running: running.includes(t.transitionId),
        }));

      // --- tool-net library (usage ledger when master exposes it) ---
      const tn = tnRes?.success ? tnRes.data : null;
      const toolNets = tn
        ? { count: Array.isArray(tn) ? tn.length : (tn.tools?.length ?? tn.count ?? 0), library: tn }
        : { count: 0, note: 'tool-net library unavailable' };

      // --- transitions hosted by THIS process (client-side LLM execution) ---
      const hosted = [...ctx.hostedRunners.values()]
        .filter((r) => r.model === model)
        .map((r) => ({ transitionId: r.transitionId, intervalMs: r.intervalMs, ...r.stats }));

      return {
        model,
        // paused = nothing is polling: no transition can fire until resume_model / start_transition.
        paused: txList.length > 0 && running.length === 0,
        transitions: { total: txList.length, byStatus, running, notRunning },
        scheduled,
        ...(hosted.length ? { hosted } : {}),
        llm: {
          eventsScanned: events.length,
          calls: llmTx.reduce((n, t) => n + t.calls, 0),
          errors: llmTx.reduce((n, t) => n + t.errors, 0),
          byTransition,
        },
        activity: { fires, fireErrors, byKind: activityByKind },
        recentErrors,
        toolNets,
      };
    }),
  );

  server.registerTool(
    'list_models',
    {
      title: 'List models on the stack',
      description:
        "All models node knows about (id, name, state) with an `allowed` flag showing which ones THIS connection may target. Models outside the allowlist are visible but not targetable — create_model minted models join the allowlist automatically.",
      inputSchema: {},
    },
    wrapTool(scope, config.mode, { name: 'list_models', mutates: false }, async () => {
      const res = await ctx.client.nodeApi('GET', '/admin/models');
      const models: any[] = Array.isArray(res) ? res : (res?.models ?? []);
      return {
        count: models.length,
        models: models.map((m: any) => ({
          modelId: m.modelId ?? m.id,
          name: m.name,
          state: m.state ?? m.status,
          allowed: scope.allowed.includes(m.modelId ?? m.id),
        })),
        allowlist: scope.allowed,
      };
    }),
  );

  server.registerTool(
    'list_executors',
    {
      title: 'List registered command executors',
      description:
        "List the command executors currently registered (ONLINE/STALE, allowedModels). Command transitions choose their executor via action.executorId — when more than one executor is ONLINE and the user has not specified one, ask the user which executor to target before creating the transition; '*' = any executor (first token reservation wins); omitted = agentic-net-executor-default.",
      inputSchema: {
        activeOnly: z.boolean().optional().describe('Only executors seen within the liveness TTL (default true)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'list_executors', mutates: false }, async (model, args) => {
      const query: Record<string, string> = { activeOnly: String(args.activeOnly ?? true) };
      // Only filter by model when the caller asked for one — master's modelId
      // filter matches executors that have actually polled that model.
      if (args.model) query.modelId = model;
      return ctx.client.masterApi('GET', '/executors', undefined, query);
    }),
  );

  // Master-side diagnostics — debug a net WITHOUT source or log access. These
  // travel as POST, which the readonly gateway scope rejects (like ArcQL), so
  // they are only registered in rw mode. net_stats (all GET) stays readonly-safe.
  if (config.mode === 'readonly') return;
  for (const [name, title, description, method] of [
    [
      'diagnose_transition',
      'Diagnose a transition',
      'Master-side diagnosis of why a transition is not firing (binding, preset arcql, token shape, live status). No logs needed.',
      'diagnoseTransition',
    ],
    [
      'dry_run_transition',
      'Dry-run a transition',
      'Simulate a fire WITHOUT emitting — what the transition would consume and produce given current tokens. Safe, no state change.',
      'dryRunTransition',
    ],
    [
      'verify_inscription',
      'Verify an inscription',
      'Static validation of a transition inscription (schema, presets/postsets, emit rules) — catches wiring mistakes before you fire.',
      'verifyInscription',
    ],
  ] as const) {
    server.registerTool(
      name,
      { title, description, inputSchema: { transitionId: z.string(), ...modelParam } },
      wrapTool(scope, config.mode, { name, mutates: false }, async (model, args) =>
        (ctx.master as any)[method](args.transitionId, model),
      ),
    );
  }
}
