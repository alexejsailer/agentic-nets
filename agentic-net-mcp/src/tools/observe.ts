/**
 * Observability layer — read-only windows into a model. These three tools are
 * the full registration set in readonly mode (plus memory_recall/memory_graph).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { fetchTokens } from './memory.js';

/**
 * Executor coverage: is any ONLINE executor actually POLLING this model? The master advertises a
 * model to an executor's discovery only while node reports it ACTIVE, so an executor that is
 * *allowed* to serve the model (allowedModels `["*"]` or the model itself) yet is not currently
 * polling it will silently never run the model's command lanes — the classic "queued: true, no
 * output" stall. Each registry entry's `models` = models the executor has actually polled; that,
 * not `allowedModels`, is what decides whether command transitions fire.
 */
async function fetchExecutors(ctx: AppContext, activeOnly = true): Promise<any[]> {
  try {
    const res: any = await ctx.client.masterApi('GET', '/executors', undefined, { activeOnly: String(activeOnly) });
    return res?.executors ?? (Array.isArray(res) ? res : []);
  } catch {
    return [];
  }
}

export function coverageFromExecutors(executors: any[], model: string) {
  const has = (arr: any, v: string) => Array.isArray(arr) && arr.includes(v);
  const online: string[] = executors.map((e) => e?.executorId).filter(Boolean);
  const polling: string[] = executors.filter((e) => has(e?.models, model)).map((e) => e.executorId);
  const allowedButIdle: string[] = executors
    .filter((e) => !has(e?.models, model))
    .filter((e) => has(e?.allowedModels, '*') || has(e?.allowedModels, model))
    .map((e) => e.executorId);
  return { online, polling, allowedButIdle, covered: polling.length > 0 };
}

/**
 * Human-facing warning when a model's command lanes have no executor. `commandCount` gates the
 * noise: pass it where the count is known (net_stats), omit it where demand is assumed
 * (list_executors / diagnosing a command transition). Returns undefined when coverage is fine.
 */
export function coverageWarning(
  cov: { online: string[]; polling: string[]; allowedButIdle: string[]; covered: boolean },
  model: string,
  commandCount?: number,
): string | undefined {
  if (cov.covered) return undefined;
  if (commandCount != null && commandCount === 0) return undefined;
  const demand = commandCount != null ? `${commandCount} command transition(s)` : 'command transitions';
  if (cov.online.length === 0) {
    return `No command executor is ONLINE — ${demand} on '${model}' cannot fire.`;
  }
  let msg = `No executor is polling model '${model}' (${cov.online.length} online, serving other models) — ${demand} will queue and never fire.`;
  if (cov.allowedButIdle.length) {
    msg += ` Executor(s) [${cov.allowedButIdle.join(', ')}] are allowed to serve '${model}' but are not polling it — the master has not advertised this model to them (typically right after a master restart, until it is re-fetched as ACTIVE or receives a lifecycle call).`;
  }
  return msg;
}

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
        'Structure + live execution status. With netId: that one net (places, transitions, arcs, statuses). Without netId: the nets in THIS MCP session (sessionNets) PLUS a model-wide session summary. IMPORTANT: sessionNetCount is scoped to this connection\'s session — a freshly-connected session is empty even when the model is full, so sessionNetCount:0 does NOT mean the model is empty (check modelSessionCount / sessionIds, or pass a sessionId).',
      inputSchema: {
        netId: z.string().optional(),
        sessionId: z.string().optional().describe('Inspect a specific session instead of this connection\'s session'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'net_overview', mutates: false }, async (model, args) => {
      const executor = ctx.executorFor(model);
      if (args.netId) {
        const res = await executor.execute('GET_NET_OVERVIEW', { netId: args.netId, sessionId: args.sessionId ?? config.session });
        if (!res.success) throw new Error(res.error ?? 'overview failed');
        return res.data;
      }
      const sessionId = args.sessionId ?? config.session;
      const [ovRes, sessRes] = await Promise.all([
        executor.execute('GET_SESSION_OVERVIEW', { sessionId }),
        executor.execute('LIST_ALL_SESSIONS', {}).catch(() => null),
      ]);
      if (!ovRes.success) throw new Error(ovRes.error ?? 'overview failed');
      const ov: any = ovRes.data ?? {};
      const sessRaw: any = sessRes?.success ? sessRes.data : null;
      const sessionList: any[] = Array.isArray(sessRaw) ? sessRaw : (sessRaw?.sessions ?? []);
      const sessionNetCount = ov.netCount ?? (ov.nets?.length ?? 0);
      const empty = sessionNetCount === 0;
      return {
        model,
        session: sessionId,
        // Renamed from netCount/nets so it can never be misread as a model-wide fact.
        sessionNetCount,
        sessionNets: ov.nets ?? [],
        // Model-wide context — the guardrail against "this session is empty ⇒ the model is empty".
        ...(sessionList.length
          ? { modelSessionCount: sessionList.length, sessionIds: sessionList.map((s: any) => s.sessionId ?? s.id ?? s.name ?? s).slice(0, 100) }
          : {}),
        ...(empty && sessionList.length > 1
          ? { note: `Session '${sessionId}' has no nets, but the model has ${sessionList.length} sessions — the model is NOT empty. Pass a sessionId (or netId) to inspect the others.` }
          : {}),
      };
    }),
  );

  server.registerTool(
    'query_tokens',
    {
      title: 'Query tokens in a place',
      description:
        'Read tokens from any runtime place with ArcQL. Paths: bare place id (resolved under root/workspace/places) or a full node path. ArcQL: FROM $ [WHERE $.field=="value"] [ORDER BY $.f DESC] [LIMIT n] — note == and double quotes. Token properties STRINGIFY nested objects/arrays: a field that was written as an array comes back as a JSON-encoded string — parse it (sometimes twice for LLM output) before use.',
      inputSchema: {
        place: z.string().optional().describe('Place id or full path (alias: placeId)'),
        placeId: z.string().optional().describe('Alias for `place`'),
        arcql: z.string().optional().describe('Default: FROM $ LIMIT 100'),
        fields: z.array(z.string()).optional().describe('Project only these token fields'),
        maxValueLength: z.number().optional().describe('Truncate long values (default 500 when no fields projection)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'query_tokens', mutates: false }, async (model, args) => {
      const place = String(args.place ?? args.placeId ?? '').trim();
      if (!place) throw new Error('provide `place` (a place id or full path; `placeId` is accepted as an alias)');
      // Without ArcQL, use the GET runtime endpoint — works under the gateway's
      // readonly scope too (ArcQL travels as POST, which readonly rejects).
      if (!args.arcql && !place.includes('/')) {
        const tokens = await fetchTokens(ctx, model, place);
        return { place, resultCount: tokens.length, results: tokens };
      }
      const placePath = place.includes('/') ? place : `root/workspace/places/${place}`;
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
        limit: z.number().optional().describe('Default 50, capped at 200 (larger pages can exceed the response-size cap and truncate)'),
        before: z.number().optional().describe('Page backwards: return events with seq < this. Use the nextBeforeSeq from a prior call to walk into older history.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'event_trail', mutates: false }, async (model, args) => {
      // Cap the page so a big limit can't blow the response-size ceiling (which truncated into
      // invalid JSON). Page further back with `before` instead of one giant window.
      const requested = Number(args.limit ?? 50);
      const limit = Math.min(Math.max(1, requested), 200);
      const query: Record<string, string> = { limit: String(limit) };
      for (const k of ['q', 'correlationId', 'category', 'status'] as const) {
        if (args[k] != null && args[k] !== '') query[k] = String(args[k]);
      }
      if (args.before != null) {
        query.before = String(args.before);
        query.beforeSeq = String(args.before); // tolerate either server param name
      }
      const res: any = await ctx.client.masterApi('GET', `/event-line/${model}`, undefined, query);
      return requested > 200 && res && typeof res === 'object'
        ? { ...res, note: `limit capped to 200 (requested ${requested}); page older events with \`before\`` }
        : res;
    }),
  );

  server.registerTool(
    'net_stats',
    {
      title: 'Model statistics — LLM usage, running transitions, tool-nets',
      description:
        'Aggregated operational stats for a model, computed with NO log-file or source access. Reports: which transitions are RUNNING vs STOPPED/ERROR (+ a paused flag when nothing runs); which transitions carry a SCHEDULE (cron/interval — i.e. what will fire overnight on its own); LLM consumption (llm + agent transition fires — calls, errors, avg duration, per transition) derived from the event line; overall activity by kind; the most recent error events; the tool-net library; and executorCoverage — whether an ONLINE executor is actually polling this model, because command transitions can look RUNNING with a full queue yet never fire when nothing is polling. This is how you answer "what is consuming LLM / what is running / what will run while I sleep / what just broke / why are my command lanes stuck".',
      inputSchema: {
        window: z.number().optional().describe('How many recent events to aggregate for LLM/activity stats (default 500)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'net_stats', mutates: false }, async (model, args) => {
      const window = args.window ?? 500;
      const [txRes, evRes, tnRes, insRes, execList] = await Promise.all([
        ctx.client.masterApi('GET', '/runtime/transitions', undefined, { modelId: model }).catch(() => null),
        ctx.client.masterApi('GET', `/event-line/${model}`, undefined, { limit: String(window) }).catch(() => null),
        ctx.executorFor(model).execute('LIST_TOOL_NETS', {}).catch(() => null),
        ctx.executorFor(model).execute('LIST_ALL_INSCRIPTIONS', { includeContent: true }).catch(() => null),
        fetchExecutors(ctx).catch(() => [] as any[]),
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

      // --- executor coverage: will this model's command lanes actually run? ---
      const commandTransitions = insList.filter((t) => t?.inscription?.action?.type === 'command').length;
      const cov = coverageFromExecutors(execList ?? [], model);
      const covWarning = coverageWarning(cov, model, commandTransitions);
      const executorCoverage = {
        commandTransitions,
        online: cov.online,
        polling: cov.polling,
        covered: cov.covered,
        ...(cov.allowedButIdle.length ? { allowedButIdle: cov.allowedButIdle } : {}),
        ...(covWarning ? { warning: covWarning } : {}),
      };

      return {
        model,
        // paused = nothing is polling: no transition can fire until resume_model / start_transition.
        paused: txList.length > 0 && running.length === 0,
        transitions: { total: txList.length, byStatus, running, notRunning },
        scheduled,
        executorCoverage,
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
    'list_transitions',
    {
      title: 'List transitions with kind + schedule + live status',
      description:
        'Every transition in the model in ONE call, each with its kind, schedule (cron/interval, or none), live status (RUNNING/STOPPED/ERROR), action type, and input/output places. This is the model-audit read — "what is this model supposed to be doing, and is it actually running?" — far cheaper than GET_TRANSITION per id (and unlike native LIST_ALL_INSCRIPTIONS, which returns bare ids without includeContent:true). Filter with kind or scheduledOnly. Pair with scheduler_status for lastFiredAt/nextFireAt and net_stats.executorCoverage for whether command lanes can even fire.',
      inputSchema: {
        kind: z.string().optional().describe('Filter to one kind: map / llm / http / command / agent / link'),
        scheduledOnly: z.boolean().optional().describe('Only transitions that carry a schedule'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'list_transitions', mutates: false }, async (model, args) => {
      const [insRes, txRes] = await Promise.all([
        ctx.executorFor(model).execute('LIST_ALL_INSCRIPTIONS', { includeContent: true }).catch(() => null),
        ctx.client.masterApi('GET', '/runtime/transitions', undefined, { modelId: model }).catch(() => null),
      ]);
      const insList: any[] = (insRes as any)?.success ? ((insRes as any).data?.transitions ?? []) : [];
      const txList: any[] = Array.isArray(txRes) ? txRes : ((txRes as any)?.transitions ?? (txRes as any)?.results ?? (txRes as any)?.data ?? []);
      const statusById = new Map<string, string>();
      for (const t of txList) {
        const id = t.transitionId ?? t.id ?? t.name;
        if (id) statusById.set(String(id), String(t.status ?? t.state ?? (t.running ? 'RUNNING' : 'STOPPED')).toUpperCase());
      }
      const placesOf = (m: any): string[] =>
        m && typeof m === 'object' ? Object.values(m).map((p: any) => p?.placeId).filter(Boolean) : [];
      // Inscriptions carry kind/schedule/places (rw only — LIST_ALL_INSCRIPTIONS travels as POST).
      // When they're unavailable (readonly), fall back to the runtime registry so we still return
      // ids + live status rather than an empty list that reads as "no transitions".
      const insById = new Map<string, any>(insList.map((t: any) => [String(t.transitionId), t.inscription ?? {}]));
      const ids = insList.length ? insList.map((t: any) => String(t.transitionId)) : [...statusById.keys()];
      let rows = ids.map((id: string) => {
        const ins = insById.get(id) ?? {};
        return {
          transitionId: id,
          kind: ins.kind ?? null,
          schedule: ins.schedule ?? null,
          status: statusById.get(id) ?? 'UNKNOWN',
          ...(ins.action?.type ? { actionType: ins.action.type } : {}),
          inputPlaces: placesOf(ins.presets),
          outputPlaces: placesOf(ins.postsets),
        };
      });
      if (args.kind) rows = rows.filter((r) => String(r.kind).toLowerCase() === String(args.kind).toLowerCase());
      if (args.scheduledOnly) rows = rows.filter((r) => r.schedule);
      return {
        model,
        count: rows.length,
        transitions: rows,
        ...(!insList.length && ids.length
          ? { note: 'inscription content did not load (readonly rejects the POST) — kind/schedule/places are blank; ids+status come from the runtime registry. Use rw mode for the full audit.' }
          : {}),
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
      title: 'List command executors + coverage for this model',
      description:
        "The command executors currently registered (ONLINE/STALE, allowedModels, and `models` = the models each is actually polling right now), PLUS coverageForModel: whether any ONLINE executor is polling the target model. Two uses: (1) BUILD-time — command transitions pick their executor via action.executorId, so when more than one executor is ONLINE and the user did not specify one, ask which to target ('*' = any executor, first reservation wins; omitted = agentic-net-executor-default). (2) DEBUG-time — a command transition that fires with no output almost always means no executor is polling its model; coverageForModel.covered=false is the smoking gun (allowedButIdle lists executors permitted to serve it but not currently polling, e.g. after a master restart).",
      inputSchema: {
        activeOnly: z.boolean().optional().describe('Only executors seen within the liveness TTL (default true)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'list_executors', mutates: false }, async (model, args) => {
      const executors = await fetchExecutors(ctx, args.activeOnly ?? true);
      const cov = coverageFromExecutors(executors, model);
      const warning = coverageWarning(cov, model);
      return {
        count: executors.length,
        executors,
        coverageForModel: {
          model,
          polling: cov.polling,
          covered: cov.covered,
          ...(cov.allowedButIdle.length ? { allowedButIdle: cov.allowedButIdle } : {}),
          ...(warning ? { warning } : {}),
        },
        fieldGuide: {
          status: 'ONLINE = seen within the liveness TTL (working); STALE = not seen recently',
          connected: 'true only for WebSocket executors; an HTTP-polling executor is connected:false yet fully ONLINE and serving',
          models: 'models this executor is ACTUALLY polling right now — this, not allowedModels, decides whether a command lane fires',
          allowedModels: 'models it is PERMITTED to serve (["*"] = any); a superset of `models`. Allowed-but-not-polling shows up as allowedButIdle above',
        },
      };
    }),
  );

  server.registerTool(
    'llm_health',
    {
      title: 'LLM provider health (check BEFORE building llm nets)',
      description:
        "Is the master's LLM provider ready to serve llm/agent transitions? Returns provider, model, reachable, modelPresent, and status (READY | MODEL_NOT_FOUND | UNREACHABLE). Check this FIRST when building an llm/agent net or when LLM lanes fail silently — a cloud model that isn't logged in, or an unreachable provider, fails every fire (and each backoff retry is a billed call). GET-based: works in readonly mode too.",
      inputSchema: {},
    },
    wrapTool(scope, config.mode, { name: 'llm_health', mutates: false }, async () => {
      const res: any = await ctx.client.masterApi('GET', '/llm/health');
      const status = String(res?.status ?? 'unknown').toUpperCase();
      return {
        ...res,
        ...(status !== 'READY'
          ? { warning: `LLM provider is ${status} — llm/agent transitions will fail on every fire until this is fixed (each retry billed).` }
          : {}),
      };
    }),
  );

  server.registerTool(
    'scheduler_status',
    {
      title: 'Scheduler status — lastFiredAt / nextFireAt / why-not-eligible per lane',
      description:
        'The answer to "my scheduled nets silently stopped". For each scheduled transition: schedule, lastFiredAt, nextFireAt, live status, ready (token binding), eligibility (why it is/is not firing — a schedule is an AND-gate with token binding, so RUNNING + valid schedule + unbindable preset = silent forever), and overdue (nextFireAt in the past while RUNNING = the scheduler has not re-armed it, classically after a master redeploy). Pass scheduledOnly:false for every transition. GET-based: works in readonly mode too.',
      inputSchema: {
        scheduledOnly: z.boolean().optional().describe('Only transitions carrying a schedule (default true)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'scheduler_status', mutates: false }, async (model, args) => {
      const res: any = await ctx.client.masterApi('GET', `/models/${model}/execution/status`);
      const list: any[] = res?.transitions ?? [];
      const now = Date.now();
      const fmtAgo = (ms: number) => {
        const s = Math.max(0, Math.round((now - ms) / 1000));
        return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`;
      };
      let rows = list.map((t: any) => {
        const sched = t.schedule ?? null;
        const lastMs = sched?.lastFiredAtMillis ?? null;
        const nextMs = sched?.nextFireAtMillis ?? null;
        const running = String(t.status ?? '').toUpperCase() === 'RUNNING';
        const overdue = running && typeof nextMs === 'number' && nextMs < now - 60_000;
        return {
          transitionId: t.transitionId,
          kind: t.kind,
          status: t.status,
          ready: t.ready,
          ...(t.eligibility ? { eligibility: t.eligibility } : {}),
          schedule: sched,
          lastFiredAt: typeof lastMs === 'number' ? new Date(lastMs).toISOString() : null,
          ...(typeof lastMs === 'number' ? { lastFiredAgo: fmtAgo(lastMs) } : { neverFired: true }),
          nextFireAt: typeof nextMs === 'number' ? new Date(nextMs).toISOString() : null,
          ...(overdue
            ? { overdue: true, hint: 'nextFireAt is in the past while RUNNING — the scheduler has not re-armed this lane (typical after a master redeploy). A stop → fire_once → start of any transition in the model re-registers its schedules.' }
            : {}),
        };
      });
      if (args.scheduledOnly !== false) rows = rows.filter((r) => r.schedule);
      const overdueCount = rows.filter((r: any) => r.overdue).length;
      return {
        model,
        observedAt: res?.observedAt,
        count: rows.length,
        ...(overdueCount ? { overdueCount } : {}),
        transitions: rows,
      };
    }),
  );

  server.registerTool(
    'usage_report',
    {
      title: 'Token-cost meter — ranked per-transition burn',
      description:
        'The answer to "what is this model\'s spend, and which lanes cause it". Ranks every transition that fired by MEASURED tokens (per-fire average, iterations, duration) over a window, with the burnSplit headline: how much is scheduled coordinators firing on idle vs real work. The analyze-and-adapt loop: (1) usage_report ranks the burn, (2) the expensive lanes are almost always agent-kind thinkers, not the frequent cheap command lanes, (3) retune with set_schedule / a schedule.intervalMs edit — live, no redeploy (lengthening never triggers a fire; shortening can fire immediately), (4) scheduler_status shows the new nextFireAt. Caveat: command lanes whose scripts spawn their OWN model calls are invisible to this counter — read the script bodies when the ranking looks too clean. GET-based: works in readonly mode too.',
      inputSchema: {
        since: z.string().optional().describe('Window, e.g. 1h / 24h / 7d (default 24h)'),
        sort: z.string().optional().describe('tokens (default) | fires | avgDuration'),
        limit: z.number().optional().describe('Max ranked rows (default 20)'),
        transitionId: z.string().optional().describe('Drill into ONE transition: aggregate + its recent fires'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'usage_report', mutates: false }, async (model, args) => {
      if (args.transitionId) {
        return ctx.client.masterApi('GET', `/usage/transitions/${args.transitionId}`, undefined, { modelId: model });
      }
      const res: any = await ctx.client.masterApi('GET', '/usage/transitions', undefined, {
        modelId: model,
        sort: String(args.sort ?? 'tokens'),
        since: String(args.since ?? '24h'),
        limit: String(args.limit ?? 20),
      });
      const top = (res?.transitions ?? [])[0];
      return {
        ...res,
        ...(top?.totalTokens
          ? { hint: `Top burner: ${top.transitionId ?? '?'} (${top.totalTokens} tokens in ${res.since}). If it is an agent/llm lane on a schedule, one set_schedule interval edit dials it down live — docs/cost.` }
          : {}),
      };
    }),
  );

  // Master-side diagnostics — debug a net WITHOUT source or log access. These
  // travel as POST, which the readonly gateway scope rejects (like ArcQL), so
  // they are only registered in rw mode. net_stats (all GET) stays readonly-safe.
  if (config.mode === 'readonly') return;

  // diagnose_transition is registered on its own because for COMMAND transitions it augments the
  // master diagnosis with executor coverage — the one failure the master itself cannot see (it does
  // not know whether any executor is polling this model). That is the top silent cause of
  // "fires but nothing happens".
  server.registerTool(
    'diagnose_transition',
    {
      title: 'Diagnose a transition',
      description:
        'Master-side diagnosis of why a transition is not firing (binding, preset arcql, token shape, live status), PLUS for COMMAND transitions an executorCoverage check — no executor polling this model means the command queues and never fires. No logs needed.',
      inputSchema: { transitionId: z.string(), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'diagnose_transition', mutates: false }, async (model, args) => {
      const diagnosis = await (ctx.master as any).diagnoseTransition(args.transitionId, model);
      // Only command transitions are executor-served, so coverage is only relevant for them.
      let isCommand = false;
      try {
        const t = await ctx.executorFor(model).execute('GET_TRANSITION', { transitionId: args.transitionId });
        isCommand = (t as any)?.data?.inscription?.action?.type === 'command';
      } catch {
        /* leave isCommand false — never fabricate a coverage warning we cannot substantiate */
      }
      if (!isCommand) return diagnosis;
      const cov = coverageFromExecutors(await fetchExecutors(ctx), model);
      const warning = coverageWarning(cov, model, 1);
      const executorCoverage = {
        polling: cov.polling,
        covered: cov.covered,
        ...(cov.allowedButIdle.length ? { allowedButIdle: cov.allowedButIdle } : {}),
        ...(warning ? { warning } : {}),
      };
      return diagnosis && typeof diagnosis === 'object' && !Array.isArray(diagnosis)
        ? { ...diagnosis, executorCoverage }
        : { diagnosis, executorCoverage };
    }),
  );

  for (const [name, title, description, method] of [
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
