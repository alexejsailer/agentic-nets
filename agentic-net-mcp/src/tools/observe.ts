/**
 * Observability layer — read-only windows into a model. These three tools are
 * the full registration set in readonly mode (plus memory_recall/memory_graph).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { fetchTokens } from './memory.js';
import { annotateLeases, LEASED_NOTE } from './lease-util.js';
import { createAllowlistStoreAt } from '../allowlist-store.js';

/**
 * Executor availability has two healthy phases. READY means an ONLINE executor is already polling
 * the model. STANDBY means one is eligible but has no assignment there yet: discovery is
 * intentionally assignment-driven, so the executor starts polling after the first command lane is
 * assigned. Only UNAVAILABLE means a command lane has no executor that can serve it.
 *
 * `covered` and `allowedButIdle` remain as compatibility fields for older clients; new callers
 * should use `state` / `available` / `eligible`.
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
  const onlineExecutors = executors.filter((e) => String(e?.status ?? 'ONLINE').toUpperCase() !== 'STALE');
  const online: string[] = onlineExecutors.map((e) => e?.executorId).filter(Boolean);
  const polling: string[] = onlineExecutors.filter((e) => has(e?.models, model)).map((e) => e.executorId);
  const eligible: string[] = onlineExecutors
    .filter((e) => {
      if (has(e?.models, model)) return true;
      // Empty/missing allowedModels is the legacy unrestricted registration shape.
      return !Array.isArray(e?.allowedModels) || e.allowedModels.length === 0
        || has(e.allowedModels, '*') || has(e.allowedModels, model);
    })
    .map((e) => e.executorId);
  const allowedButIdle: string[] = onlineExecutors
    .filter((e) => !has(e?.models, model))
    .filter((e) => eligible.includes(e.executorId))
    .map((e) => e.executorId);
  const covered = polling.length > 0;
  const available = eligible.length > 0;
  const state = covered ? 'READY' : available ? 'STANDBY' : 'UNAVAILABLE';
  return { state, available, online, eligible, polling, allowedButIdle, covered };
}

/**
 * Human-facing warning when a model's command lanes have no executor. `commandCount` gates the
 * noise: pass it where the count is known (net_stats), omit it where demand is assumed
 * (list_executors / diagnosing a command transition). Returns undefined when coverage is fine.
 */
export function coverageWarning(
  cov: ReturnType<typeof coverageFromExecutors>,
  model: string,
  commandCount?: number,
): string | undefined {
  if (cov.covered) return undefined;
  if (commandCount != null && commandCount === 0) return undefined;
  const demand = commandCount != null ? `${commandCount} command transition(s)` : 'command transitions';
  if (cov.available) {
    // With no known demand this is normal standby, not a warning. Once a command lane exists it
    // should move to READY after the next assignment-discovery cycle.
    if (commandCount == null) return undefined;
    return `Executor activation is pending for model '${model}' — ${demand} exist and eligible executor(s) [${cov.eligible.join(', ')}] are STANDBY, not polling yet. Discovery is automatic (about 5s in Desktop Lite; 30s by default elsewhere). If it remains STANDBY beyond one cycle, re-check the transition's executorId/assignedAgent and model ACTIVE state.`;
  }
  if (cov.online.length === 0) {
    return `No command executor is ONLINE — ${demand} on '${model}' cannot fire.`;
  }
  return `No ONLINE executor is eligible for model '${model}' (${cov.online.length} online but excluded by allowedModels) — ${demand} cannot fire.`;
}

/**
 * Every ArcQL token comes back with its content TWICE — once as `data`, once as
 * `_meta.properties` — byte-identical. Worse, a `fields` projection trimmed only `data`, so asking
 * for 2 fields of a 2828-char token still shipped the whole token and the projection did nothing
 * for the payload size it exists to control.
 *
 * Drop `_meta.properties` when it merely repeats `data`, and project it when it does not (the two
 * genuinely differ on some paths — properties can carry `_lock`, `_parentPlace` and friends that
 * `data` omits — so this narrows rather than discards). The rest of `_meta` (id, name, parentId,
 * type) is small and load-bearing, and stays.
 */
export function dedupeTokenPayload(data: any, fields?: string[]): any {
  if (!data || typeof data !== 'object') return data;
  const rows = (data as any).results ?? (data as any).tokens;
  if (!Array.isArray(rows)) return data;

  let deduped = 0;
  for (const row of rows) {
    const meta = row?._meta;
    const props = meta?.properties;
    if (!props || typeof props !== 'object') continue;

    const body = row?.data && typeof row.data === 'object' ? row.data : null;
    const sameAsData = body && JSON.stringify(body) === JSON.stringify(props);
    if (sameAsData) {
      delete meta.properties;
      deduped++;
      continue;
    }
    if (fields?.length) {
      const kept: Record<string, any> = {};
      // Keep the projected fields plus the underscore-prefixed engine metadata that only ever
      // lives here — dropping _lock would hide why a token cannot be bound.
      for (const [k, v] of Object.entries(props)) {
        if (fields.includes(k) || k.startsWith('_')) kept[k] = v;
      }
      meta.properties = kept;
    }
  }
  return deduped ? { ...data, _note: `${deduped} token(s): _meta.properties omitted (identical to data)` } : data;
}

/**
 * Loud, structural truncation of long string values (protocol-hardening trap
 * #3: any cap must cut at a boundary AND announce itself — silent truncation
 * composes catastrophically once an LLM consumes the result). Marker mirrors
 * node's ArcQL convention. max <= 0 disables.
 */
export function clampValues(value: any, max: number, state: { truncated: boolean }): any {
  if (max <= 0) return value;
  if (typeof value === 'string') {
    if (value.length <= max) return value;
    state.truncated = true;
    // A JSON-bearing string must stay structurally honest. Returning a clipped fragment makes it
    // look usable while guaranteeing that the next parser fails. Only inspect strings that are
    // already being truncated; ordinary read-path strings keep their exact type and value.
    try {
      JSON.parse(value);
      return {
        __truncated__: {
          bytes: Buffer.byteLength(value, 'utf8'),
          preview: value.slice(0, 120),
        },
      };
    } catch {
      // Plain string: keep the established loud inline marker.
    }
    return value.slice(0, max) + `...[truncated, ${value.length} chars total]`;
  }
  if (Array.isArray(value)) return value.map((v) => clampValues(v, max, state));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clampValues(v, max, state);
    return out;
  }
  return value;
}

const EVENT_FILTER_KEYS = [
  'q', 'correlationId', 'category', 'type', 'status', 'sessionId', 'workspaceNetId', 'source',
] as const;

const HISTORY_FILTER_KEYS = [
  'afterVersion', 'beforeVersion', 'limit', 'eventType', 'elementId', 'parentId',
  'transactionId', 'correlationId', 'causationId', 'sessionId', 'workspaceNetId',
  'transitionId', 'fireId', 'q', 'includeEvents',
] as const;

function copyQuery(
  args: Record<string, any>,
  keys: readonly string[],
  initial: Record<string, string> = {},
): Record<string, string> {
  const query = { ...initial };
  for (const key of keys) {
    if (args[key] != null && args[key] !== '') query[key] = String(args[key]);
  }
  return query;
}

export function eventStories(events: any[], includeMutations = false): any[] {
  const chronological = [...events]
    .filter((event) => includeMutations || String(event?.category ?? '') !== 'mutation')
    .sort((a, b) => Number(a?.seq ?? 0) - Number(b?.seq ?? 0));
  const grouped = new Map<string, any[]>();
  for (const event of chronological) {
    const correlationId = String(event?.correlationId ?? '').trim();
    const key = correlationId || `event:${event?.seq ?? grouped.size}`;
    const story = grouped.get(key) ?? [];
    story.push(event);
    grouped.set(key, story);
  }
  return [...grouped.entries()]
    .map(([key, steps]) => {
      const terminal = [...steps].reverse().find((event) =>
        ['success', 'error', 'blocked', 'skipped'].includes(String(event?.status ?? '').toLowerCase()),
      );
      const first = steps[0];
      const last = steps[steps.length - 1];
      return {
        correlationId: key.startsWith('event:') ? null : key,
        firstSeq: first?.seq,
        lastSeq: last?.seq,
        startedAt: first?.ts,
        finishedAt: last?.ts,
        outcome: terminal?.status ?? last?.status,
        headline: terminal?.summary ?? last?.summary,
        steps,
      };
    })
    .sort((a, b) => Number(b.lastSeq ?? 0) - Number(a.lastSeq ?? 0));
}

export function registerObserveTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const allowlist = createAllowlistStoreAt(config.allowlistPath, config.persistAllowlist);
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'net_overview',
    {
      title: 'Net / session overview',
      description:
        'Structure + live execution status. With netId: that one net (places, transitions, arcs, statuses) plus its convergence points — fanIn (places MORE THAN ONE transition writes) and fanOut (places more than one reads, i.e. lanes racing for the same tokens unless their ArcQL filters are disjoint), both derived from inscriptions and excluding token-less link transitions. Note sharedPlaces means something else: places this net shares with ANOTHER net in the session (cross-net coupling), so it is empty for a place two of this net\'s own transitions meet at — that is fanIn. Without netId: the nets in THIS MCP session (sessionNets) PLUS a model-wide session summary. IMPORTANT: sessionNetCount is scoped to this connection\'s session — a freshly-connected session is empty even when the model is full, so sessionNetCount:0 does NOT mean the model is empty (check modelSessionCount / sessionIds, or pass a sessionId).',
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
        'Read tokens from any runtime place with ArcQL. Paths: bare place id (resolved under root/workspace/places) or a full node path. ArcQL: FROM $ [WHERE $.field=="value"] [ORDER BY $.f DESC] [LIMIT n] — note == and double quotes. Tokens held by an IN-FLIGHT fire are still listed (visible ≠ available) and carry leased:{owner,expiresInMs} — see docs/leases before treating a lingering token as queued or stuck. Token properties STRINGIFY nested objects/arrays: a field that was written as an array comes back as a JSON-encoded string — parse it (sometimes twice for LLM output) before use.',
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
        // Honor `fields` on this path too (it used to be silently ignored here —
        // an ignored param is a misconception that must not vanish, trap #4).
        const state = { truncated: false };
        let results: any[];
        if (args.fields?.length) {
          results = tokens.map((t: any) => {
            const src = t?.data && Object.keys(t.data).length ? t.data : (t?.properties ?? {});
            const out: Record<string, any> = {};
            for (const f of args.fields as string[]) if (src[f] !== undefined) out[f] = src[f];
            return out;
          });
        } else {
          // Apply the documented per-value cap on this path too (the ArcQL path
          // already defaults to 500 server-side). Loud + structural: whole values
          // get an inline marker (or a __truncated__ object for JSON strings) and the response carries truncated:true — pass
          // maxValueLength:0 for uncapped values.
          const max = Number(args.maxValueLength ?? 500);
          results = clampValues(tokens, max, state);
        }
        const leases = annotateLeases(tokens, results);
        return {
          place,
          resultCount: tokens.length,
          results,
          ...(leases.leasedCount ? { leasedCount: leases.leasedCount, leasedNote: LEASED_NOTE } : {}),
          ...(state.truncated
            ? { truncated: true, note: 'long values shortened (JSON strings use structured __truncated__ markers; plain strings use inline markers) — re-query with maxValueLength:0 for full values' }
            : {}),
        };
      }
      const placePath = place.includes('/') ? place : `root/workspace/places/${place}`;
      const res = await ctx.executorFor(model).execute('QUERY_TOKENS', {
        placePath,
        query: args.arcql ?? 'FROM $ LIMIT 100',
        ...(args.fields ? { fields: args.fields } : {}),
        ...(args.maxValueLength != null ? { maxValueLength: args.maxValueLength } : {}),
      });
      if (!res.success) throw new Error(res.error ?? 'QUERY_TOKENS failed');
      const payload: any = dedupeTokenPayload(res.data, args.fields as string[] | undefined);
      const rawRows: any[] = (res.data as any)?.results ?? [];
      if (Array.isArray(payload?.results) && rawRows.length === payload.results.length) {
        const leases = annotateLeases(rawRows, payload.results);
        if (leases.leasedCount) {
          payload.leasedCount = leases.leasedCount;
          payload.leasedNote = LEASED_NOTE;
        }
      }
      return payload;
    }),
  );

  server.registerTool(
    'event_trail',
    {
      title: 'Event trail (audit log)',
      description:
        'The model event line — why a token exists, what a transition did, in order. Filter by free text, correlationId, session/workspace, category, type or status. Returns a cursor with an epoch so clients can detect Master restarts or eviction. This remains an in-memory ring (~2000 events, reset on master restart) — ABSENCE in the trail is NOT proof a fire never happened (eviction/restart erase history); scheduler_status.fireCount is the durable-ish counter, and model_history holds durable Node mutations.',
      inputSchema: {
        q: z.string().optional().describe('Free-text filter (searches summaries AND attributes, so a transitionId works here)'),
        correlationId: z.string().optional(),
        category: z.string().optional().describe('transition | agent-step | mutation | workspace | chat | assistant | agent-stream | delegation | general'),
        type: z.string().optional().describe('Within a category, e.g. category:"transition" type:"fire"'),
        status: z.string().optional().describe('For fires: requested | success | blocked | error | skipped | external-prepared | external-completed'),
        sessionId: z.string().optional(),
        workspaceNetId: z.string().optional(),
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
      Object.assign(query, copyQuery(args, EVENT_FILTER_KEYS));
      if (args.before != null) {
        query.before = String(args.before);
        query.beforeSeq = String(args.before); // tolerate either server param name
      }
      const res: any = await ctx.client.masterApi('GET', `/event-line/${model}`, undefined, query);
      // grouped:true = the Console tab's correlation-story view (absorbs the console_tail tool).
      let shaped: any = res;
      if (args.grouped && res && Array.isArray(res.events)) {
        const { events, ...rest } = res;
        shaped = { ...rest, stories: eventStories(events, true) };
      }
      return requested > 200 && shaped && typeof shaped === 'object'
        ? { ...shaped, note: `limit capped to 200 (requested ${requested}); page older events with \`before\`` }
        : shaped;
    }),
  );

  server.registerTool(
    'events_wait',
    {
      title: 'Wait for model events',
      description:
        'Long-poll the Master event line without holding an SSE connection. Pass nextAfterSeq and cursor.epoch from the previous response. resetDetected=true means the Master restarted or the cursor fell behind the 2,000-event ring; resync with console_tail/model_history.',
      inputSchema: {
        afterSeq: z.number().optional().describe('Last processed sequence; default 0'),
        epoch: z.string().optional().describe('cursor.epoch from the previous event response'),
        timeoutMs: z.number().optional().describe('100..30000, default 25000'),
        limit: z.number().optional().describe('Buffered catch-up size, default server limit'),
        q: z.string().optional(),
        correlationId: z.string().optional(),
        category: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        sessionId: z.string().optional(),
        workspaceNetId: z.string().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'events_wait', mutates: false }, async (model, args) => {
      const query = copyQuery(args, EVENT_FILTER_KEYS, {
        afterSeq: String(Math.max(0, Number(args.afterSeq ?? 0))),
        timeoutMs: String(Math.min(30_000, Math.max(100, Number(args.timeoutMs ?? 25_000)))),
      });
      if (args.epoch) query.epoch = String(args.epoch);
      if (args.limit != null) query.limit = String(Math.min(200, Math.max(1, Number(args.limit))));
      return ctx.client.masterApi('GET', `/event-line/${model}/wait`, undefined, query);
    }),
  );

  server.registerTool(
    'model_history',
    {
      title: 'Durable Node mutation history',
      description:
        'Read retained model-scoped EventBlocks directly from the Node journal through Master/Gateway. Unlike the Master console ring, these structural/token mutations survive restarts; snapshot compaction can remove old blocks. Filter by causal metadata to connect a fire to exact committed events.',
      inputSchema: {
        afterVersion: z.number().optional(),
        beforeVersion: z.number().optional().describe('Page backwards by model version'),
        limit: z.number().optional().describe('Default 100, capped at 500'),
        eventType: z.string().optional(),
        elementId: z.string().optional(),
        parentId: z.string().optional(),
        transactionId: z.string().optional(),
        correlationId: z.string().optional(),
        causationId: z.string().optional(),
        sessionId: z.string().optional(),
        workspaceNetId: z.string().optional(),
        transitionId: z.string().optional(),
        fireId: z.string().optional(),
        q: z.string().optional(),
        includeEvents: z.boolean().optional().describe('Default true'),
        blockId: z.string().optional().describe('Fetch ONE complete EventBlock by id (causal metadata + committed events) instead of a filtered page'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'model_history', mutates: false }, async (model, args) => {
      if (args.blockId) {
        return ctx.client.masterApi('GET', `/models/${model}/event-history/${encodeURIComponent(String(args.blockId))}`);
      }
      const query = copyQuery(args, HISTORY_FILTER_KEYS);
      if (args.limit != null) query.limit = String(Math.min(500, Math.max(1, Number(args.limit))));
      return ctx.client.masterApi('GET', `/models/${model}/event-history`, undefined, query);
    }),
  );

  server.registerTool(
    'transition_history',
    {
      title: 'Joined transition execution history',
      description:
        'Join operational Master events with durable Node mutations for one transition. correlationId/fireId metadata connects a console story to the exact mutation EventBlocks.',
      inputSchema: {
        transitionId: z.string(),
        limit: z.number().optional().describe('Default 100, capped at 200 per history'),
        includeEvents: z.boolean().optional(),
        focus: z.enum(['all', 'failures']).optional().describe("failures: latest correlated failure story + error events + (rw) master binding diagnosis — use instead of guessing from a generic 'command reported failure' line"),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'transition_history', mutates: false }, async (model, args) => {
      const limit = Math.min(200, Math.max(1, Number(args.limit ?? 100)));
      const [consoleResponse, journal] = await Promise.all([
        ctx.client.masterApi('GET', `/event-line/${model}`, undefined, {
          // free-text q is a SUBSTRING match: 't-build' would pull 't-build-2' stories into
          // this lane's history (review L2). Fetch a window and filter by the exact attribute.
          limit: String(Math.min(1000, limit * 5)),
        }),
        ctx.client.masterApi('GET', `/models/${model}/event-history`, undefined, {
          transitionId: String(args.transitionId), limit: String(limit),
          includeEvents: String(args.includeEvents !== false),
        }),
      ]);
      const live: any = consoleResponse;
      const wanted = String(args.transitionId);
      const exact = (live?.events ?? []).filter((e: any) =>
        e?.attributes?.transitionId === wanted
        || (e?.correlationId && (live?.events ?? []).some((s2: any) =>
              s2?.correlationId === e.correlationId && s2?.attributes?.transitionId === wanted)));
      if (args.focus === 'failures') {
        // absorbed failure_context: the latest correlated failure story with its raw error
        // events, the committed mutations, and (rw only) the master's binding diagnosis.
        const errors = exact.filter((e: any) => String(e?.status ?? '').toLowerCase() === 'error');
        const latestCorrelation = errors[0]?.correlationId;
        const related = latestCorrelation
          ? exact.filter((e: any) => e?.correlationId === latestCorrelation)
          : errors;
        const diagnosis = ctx.config.mode === 'readonly'
          ? null
          : await (ctx.master as any).diagnoseTransition(args.transitionId, model).catch((error: any) => ({
              unavailable: true, error: error?.message ?? String(error),
            }));
        return {
          modelId: model,
          transitionId: args.transitionId,
          latestError: errors[0] ?? null,
          errorCountInWindow: errors.length,
          latestFailureStory: eventStories(related, true)[0] ?? null,
          committedMutations: journal,
          diagnosis,
          cursor: live?.cursor,
        };
      }
      return {
        modelId: model,
        transitionId: args.transitionId,
        console: {
          cursor: live?.cursor,
          stories: eventStories(exact, true),
          nextBeforeSeq: live?.nextBeforeSeq,
        },
        mutations: journal,
      };
    }),
  );

  server.registerTool(
    'token_lineage',
    {
      title: 'Token mutation lineage',
      description:
        'Find durable Node mutations for a token/element. Prefer elementId when known; tokenName uses text search. Causal metadata identifies which transition fire created, updated, moved, or deleted it.',
      inputSchema: {
        elementId: z.string().optional(),
        tokenName: z.string().optional(),
        limit: z.number().optional().describe('Default 100, capped at 500'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'token_lineage', mutates: false }, async (model, args) => {
      if (!args.elementId && !args.tokenName) throw new Error('provide elementId or tokenName');
      return ctx.client.masterApi('GET', `/models/${model}/event-history`, undefined, {
        ...(args.elementId ? { elementId: String(args.elementId) } : { q: String(args.tokenName) }),
        limit: String(Math.min(500, Math.max(1, Number(args.limit ?? 100)))),
        includeEvents: 'true',
      });
    }),
  );

  server.registerTool(
    'net_stats',
    {
      title: 'Model statistics — LLM usage, running transitions, tool-nets',
      description:
        'Aggregated operational stats for a model, computed with NO log-file or source access. Reports RUNNING vs STOPPED/ERROR transitions; schedules; measured llm/agent consumption; activity and recent errors; tool-net usage; and executorCoverage with READY (polling), STANDBY (eligible, activates after command assignment), or UNAVAILABLE. This answers "what consumes LLM / what is running or scheduled / what broke / can command lanes run?". paused means pause_model was used (the record resume_model restores from); idle means nothing is polling for any other reason — the two are reported separately because conflating them made net_stats and resume_model contradict each other.',
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
      const external: string[] = [];
      for (const t of txList) {
        const id = t.transitionId ?? t.id ?? t.name ?? '?';
        const status = String(t.status ?? t.state ?? (t.running ? 'RUNNING' : 'STOPPED')).toUpperCase();
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        if (status === 'RUNNING') running.push(id);
        else notRunning.push({ transitionId: id, status, ...(t.kind ? { kind: t.kind } : {}) });
        // External lane: master deliberately skips these — a client fires them
        // (list_external_fires / prepare_external_fire), so they are not "stalled".
        if (status === 'EXTERNAL') external.push(id);
      }

      // --- LLM consumption + activity + recent errors from the event line ---
      const events: any[] = evRes?.events ?? [];
      const perTx = new Map<string, { transitionId: string; kind: string; calls: number; errors: number; totalMs: number }>();
      const activityByKind: Record<string, number> = {};
      const recentErrors: any[] = [];
      let fires = 0;
      let fireErrors = 0;
      // Field finding F4b: this loop used to count every fire event twice (each fire emits a
      // 'requested' AND a terminal event) and branded every 'requested' an error via
      // `status !== 'success'` — so fireErrors > 0 on a perfectly clean model, with no error
      // records behind it. Now: `fires` counts attempts ('requested'), `fireErrors` counts
      // genuine terminal errors only, and the two are reconcilable with recentErrors.
      for (const e of events) {
        const st = String(e.status ?? '').toLowerCase();
        if ((st === 'error' || st === 'failed') && recentErrors.length < 15) {
          recentErrors.push({ seq: e.seq, ts: e.ts, category: e.category, type: e.type, summary: String(e.summary ?? '').slice(0, 200) });
        }
        if (e.category !== 'transition' || e.type !== 'fire') continue;
        const isAttempt = st === 'requested';
        const isErr = st === 'error' || st === 'failed';
        if (isAttempt) {
          fires++;
          const kind = String(e.attributes?.kind ?? 'unknown');
          activityByKind[kind] = (activityByKind[kind] ?? 0) + 1;
        }
        if (isErr) fireErrors++;
        const tid = String(e.attributes?.transitionId ?? '?');
        const kind = String(e.attributes?.kind ?? 'unknown');
        const ms = Number(e.attributes?.durationMs ?? 0) || 0;
        const cur = perTx.get(tid) ?? { transitionId: tid, kind, calls: 0, errors: 0, totalMs: 0 };
        if (kind !== 'unknown' && cur.kind === 'unknown') cur.kind = kind;
        if (isAttempt) cur.calls++;
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

      // --- executor availability + activation: can this model's command lanes run? ---
      const commandTransitions = insList.filter((t) => t?.inscription?.action?.type === 'command').length;
      const cov = coverageFromExecutors(execList ?? [], model);
      const covWarning = coverageWarning(cov, model, commandTransitions);
      const executorCoverage = {
        commandTransitions,
        state: cov.state,
        available: cov.available,
        online: cov.online,
        eligible: cov.eligible,
        polling: cov.polling,
        covered: cov.covered,
        ...(cov.allowedButIdle.length ? { allowedButIdle: cov.allowedButIdle } : {}),
        ...(covWarning ? { warning: covWarning } : {}),
      };

      // "Explicitly paused" and "nothing happens to be running" are DIFFERENT states, and
      // conflating them made net_stats report paused:true while resume_model answered "no
      // pause-record exists" — a contradiction with no way to tell which tool was wrong. Only
      // pause_model's own record means paused; everything else is idle, whatever the reason
      // (never started, stopped by hand, all lanes crashed).
      const pauseRecord = (await fetchTokens(ctx, model, 'p-mcp-control').catch(() => []))
        .map((t: any) => (t?.data && Object.keys(t.data).length ? t.data : (t?.properties ?? {})))
        .filter((d: any) => d.kind === 'pause-record')
        .sort((a: any, b: any) => String(b.pausedAt ?? '').localeCompare(String(a.pausedAt ?? '')))[0];
      const idle = txList.length > 0 && running.length === 0;

      return {
        model,
        // Set ONLY by pause_model — the same record resume_model restores from, so the two agree.
        paused: pauseRecord != null,
        ...(pauseRecord ? { pausedAt: pauseRecord.pausedAt ?? null, pausedBy: pauseRecord.source ?? null } : {}),
        // Nothing is polling, so no transition can fire — but nobody pressed the kill switch.
        idle,
        ...(idle && pauseRecord == null
          ? { idleNote: 'no lane is running, and there is NO pause record — this model was stopped or never started, so resume_model has nothing to restore; use start_transition / start_net' }
          : {}),
        transitions: { total: txList.length, byStatus, running, notRunning },
        ...(external.length
          ? { externalFires: { transitions: external, note: 'client-fired lane — see list_external_fires' } }
          : {}),
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
        'Every transition in the model in ONE call, each with kind, schedule, live status, action type, and input/output places. This is the model audit — far cheaper than GET_TRANSITION per id. Filter with kind or scheduledOnly. Pair with scheduler_status for timing/eligibility and net_stats.executorCoverage for command executor READY/STANDBY/UNAVAILABLE state.',
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
        "All models node knows about (id, name, state) with an `allowed` flag showing which ones THIS connection may target, and `allowedVia` showing WHY: env (AGENTICOS_MODELS), persisted (created here in an earlier session and remembered), or session (granted by create_model during this connection, ends when it closes). Models outside the allowlist are visible but not targetable.",
      inputSchema: {},
    },
    wrapTool(scope, config.mode, { name: 'list_models', mutates: false }, async () => {
      const res = await ctx.client.nodeApi('GET', '/admin/models');
      const models: any[] = Array.isArray(res) ? res : (res?.models ?? []);
      const envModels = config.models.filter((m) => !config.persistedModels.includes(m));
      const persistedModels = allowlist.read();
      // Distinguishing the three sources is the point: a `session` grant disappears on disconnect,
      // which is precisely the trap that left scheduled work running with no way to reach it.
      const via = (id: string): string | undefined => {
        if (!scope.allowed.includes(id)) return undefined;
        if (envModels.includes(id)) return 'env';
        if (persistedModels.includes(id)) return 'persisted';
        return 'session';
      };
      const rows = models.map((m: any) => {
        const id = m.modelId ?? m.id;
        return {
          modelId: id,
          name: m.name,
          state: m.state ?? m.status,
          allowed: scope.allowed.includes(id),
          ...(via(id) ? { allowedVia: via(id) } : {}),
        };
      });
      const sessionOnly = rows.filter((r) => r.allowedVia === 'session').map((r) => r.modelId);
      return {
        count: models.length,
        models: rows,
        allowlist: scope.allowed,
        allowlistPath: config.allowlistPath,
        ...(config.persistAllowlist ? {} : { persistence: 'disabled (AGENTICOS_PERSIST_ALLOWLIST=false)' }),
        ...(sessionOnly.length
          ? {
              warning:
                `${sessionOnly.join(', ')} ${sessionOnly.length === 1 ? 'is' : 'are'} allowed for THIS SESSION only — ` +
                'anything scheduled there keeps running after you disconnect but will not be reachable (or pausable) ' +
                'from a new session. Re-run create_model with persistAllowlist:true, or add the id to AGENTICOS_MODELS.',
            }
          : {}),
      };
    }),
  );

  server.registerTool(
    'list_executors',
    {
      title: 'List command executors + coverage for this model',
      description:
        "The command executors currently registered, PLUS coverageForModel with three explicit states: READY = polling this model now; STANDBY = eligible and command-capable, waiting for its first assignment; UNAVAILABLE = no eligible ONLINE executor. Desktop Lite's bundled executor is eligible for every model and normally appears STANDBY until a command transition is assigned, then auto-activates. Command transitions pick an executor via action.executorId; if several are ONLINE and the user did not specify one, ask which to target ('*' = any, first reservation wins; omitted = agentic-net-executor-default).",
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
          state: cov.state,
          available: cov.available,
          eligible: cov.eligible,
          polling: cov.polling,
          covered: cov.covered,
          ...(cov.allowedButIdle.length ? { allowedButIdle: cov.allowedButIdle } : {}),
          ...(warning ? { warning } : {}),
        },
        fieldGuide: {
          status: 'ONLINE = seen within the liveness TTL (working); STALE = not seen recently',
          connected: 'true only for WebSocket executors; an HTTP-polling executor is connected:false yet fully ONLINE and serving',
          models: 'models this executor is polling now; assignment-driven discovery adds a model after its first command lane is assigned',
          allowedModels: 'models it is eligible to serve (["*"] = every model); eligible-but-not-polling is normal STANDBY, not failure',
          covered: 'legacy active-polling flag; use available/state when deciding whether command lanes can be built',
        },
      };
    }),
  );

  server.registerTool(
    'llm_health',
    {
      title: 'LLM provider health (check BEFORE building llm nets)',
      description:
        "Is the master's server-side LLM provider ready to serve llm/agent transitions? Returns status READY, DISABLED (intentional MCP-first mode), MODEL_NOT_FOUND, or UNREACHABLE. DISABLED is not a runtime outage: deterministic lanes remain ready and AI lanes should use MCP external fires. Other non-READY states break master-run AI fires. GET-based: works in readonly mode too.",
      inputSchema: {},
    },
    wrapTool(scope, config.mode, { name: 'llm_health', mutates: false }, async () => {
      const res: any = await ctx.client.masterApi('GET', '/llm/health');
      return evaluateLlmHealth(res).report;
    }),
  );

  server.registerTool(
    'readiness',
    {
      title: 'Readiness — the whole dependency chain, one read-only call',
      description:
        "Walks every layer an Agentic-Net depends on and reports each one separately: gateway, node/model, credential vault, LLM provider, and command executors. Executor state is READY (polling), STANDBY (eligible; auto-activates after the first command assignment), or UNAVAILABLE. Transport-connected ≠ authenticated ≠ backend-ready ≠ capability-ready; this establishes all four BEFORE building. `ready:true` means no blocking problem found. GET-based and readonly-safe.",
      inputSchema: { ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'readiness', mutates: false }, async (model) => {
      const problems: string[] = [];
      const warnings: string[] = [];
      const gateway: any = { url: config.gatewayUrl, reachable: false, authenticated: false };
      const node: any = { reachable: false };
      let models: any[] = [];
      // One authenticated node read proves gateway reachability, credential
      // acceptance, and node health in a single round-trip; the error shape
      // tells us which layer broke.
      try {
        const res: any = await ctx.client.nodeApi('GET', '/admin/models');
        models = Array.isArray(res) ? res : (res?.models ?? []);
        gateway.reachable = true;
        gateway.authenticated = true;
        node.reachable = true;
      } catch (err: any) {
        if (err?.name === 'GatewayError') {
          gateway.reachable = true;
          if (err.status === 401 || err.status === 403) {
            problems.push(
              `gateway rejected the credential (${err.status}) — check AGENTICOS_ADMIN_SECRET / AGENTICOS_GATEWAY_SECRET_FILE against the gateway's data/jwt secrets`,
            );
          } else {
            gateway.authenticated = true;
            problems.push(`node did not answer through the gateway (${err.status}) — is agentic-net-node up?`);
          }
        } else if (/auth|401|invalid_client/i.test(String(err?.message ?? ''))) {
          // Token ACQUISITION failures surface as plain Errors, not GatewayErrors —
          // still a credential problem, not an unreachable gateway (proven live).
          gateway.reachable = true;
          problems.push(
            `gateway rejected the credential during token acquisition — check AGENTICOS_ADMIN_SECRET / AGENTICOS_GATEWAY_SECRET_FILE against the gateway's data/jwt secrets (${String(err?.message ?? err).slice(0, 120)})`,
          );
        } else {
          problems.push(`gateway unreachable at ${config.gatewayUrl}: ${String(err?.message ?? err).slice(0, 120)}`);
        }
      }

      const entry = models.find((m: any) => (m.modelId ?? m.id) === model);
      const modelReport: any = { id: model, exists: Boolean(entry), state: entry?.state ?? entry?.status ?? null };
      if (node.reachable && !entry) {
        problems.push(`model '${model}' is allowlisted for this connection but does NOT exist on the node — create_model mints it (list_models shows what exists)`);
      }
      if (entry) {
        const st = String(modelReport.state ?? '').toUpperCase();
        if (st && st !== 'ACTIVE') {
          problems.push(`model '${model}' is ${st}, not ACTIVE — master only polls ACTIVE models, so nothing fires`);
        }
        const kids = await ctx.node.getChildren(model, 'root/workspace').catch(() => null);
        modelReport.workspaceProvisioned = Array.isArray(kids) && kids.some((c: any) => c.name === 'places');
        if (modelReport.workspaceProvisioned === false) {
          modelReport.note = 'no root/workspace/places yet — provisioned automatically on the first place write (not a blocker)';
        }
      }

      // Scheduled-lane state is advisory here: an operator may intentionally stop a lane, so it
      // must not make the whole installation unready. Older masters have no execution-status
      // endpoint/fields; treat that as unknown and preserve compatibility.
      if (entry) {
        try {
          const status: any = await ctx.client.masterApi(
            'GET', `/models/${model}/execution/status`, undefined,
            { modelId: model }, // gateway routes on the query param, never the path segment
          );
          const scheduledLanes: any[] = (status?.transitions ?? []).filter((t: any) => t?.schedule);
          const stopped = scheduledLanes.filter(
            (t: any) => String(t.status ?? '').toUpperCase() !== 'RUNNING',
          );
          if (stopped.length) {
            warnings.push(
              `${stopped.length} scheduled lane(s) are stopped and will not fire: ` +
                stopped.map((t: any) => t.transitionId).join(', '),
            );
          }
          const invalid = scheduledLanes.filter((t: any) => t.schedule?.valid === false);
          if (invalid.length) {
            warnings.push(
              `${invalid.length} scheduled lane(s) have invalid schedules and fail closed: ` +
                invalid.map((t: any) => t.transitionId).join(', '),
            );
          }
        } catch {
          // Old-master compatibility: absence is not a readiness failure.
        }
      }

      // LLM provider — gates llm/agent lanes; every failed fire retries billed.
      let llm: any;
      try {
        const evaluated = evaluateLlmHealth(
          await ctx.client.masterApi('GET', '/llm/health'),
        );
        llm = evaluated.report;
        if (evaluated.problem) {
          problems.push(evaluated.problem);
        }
      } catch (err: any) {
        llm = { status: 'UNKNOWN', error: String(err?.message ?? err).slice(0, 120) };
        problems.push('master /llm/health did not answer — llm/agent readiness unknown (is agentic-net-master up?)');
      }
      // Health checks REACHABILITY and model PRESENCE, not usability: a cloud model outside the
      // account's plan answers /api/tags fine and then rejects every inference on billing. That
      // exact shape ran a staging model at 380 consecutive failures for a week while health said
      // READY. So when health is green, cross-check the recent event line: AI fires that ALL fail
      // with zero successes mean the provider is NOT usable, whatever health says.
      let llmFireCheck: { aiFires: number; aiErrors: number; lastError?: string } | undefined;
      if (isLlmHealthReady(llm?.status)) {
        try {
          const evRes: any = await ctx.client.masterApi(
            'GET', `/event-line/${model}`, undefined, { limit: '150' });
          let aiFires = 0;
          let aiErrors = 0;
          let lastError: string | undefined;
          for (const e of evRes?.events ?? []) {
            if (e.category === 'transition' && e.type === 'fire'
                && ['llm', 'agent'].includes(String(e.attributes?.kind ?? ''))) {
              aiFires++;
              if (String(e.status ?? '').toLowerCase() === 'error') aiErrors++;
            }
            // Agent-step errors carry the raw provider message the fire summary truncates.
            if (!lastError && e.category === 'agent-step'
                && String(e.status ?? '').toLowerCase() === 'error') {
              lastError = String(e.details?.error ?? e.summary ?? '').slice(0, 160);
            }
          }
          llmFireCheck = { aiFires, aiErrors, ...(lastError ? { lastError } : {}) };
          if (aiFires >= 3 && aiErrors >= aiFires) {
            llm = {
              ...llm,
              usable: false,
              warning:
                `provider reports ${llm.status} but the last ${aiFires} llm/agent fires ALL failed — `
                + 'a model can be present yet unusable (billing plan, quota, auth). Check '
                + 'net_stats.recentErrors for the raw provider error before trusting AI lanes.',
            };
            problems.push(
              `llm provider ${llm.provider ?? ''} answers health checks but every recent AI fire failed`
              + (lastError ? ` (${lastError})` : '')
              + ' — fix the provider/model before relying on llm/agent lanes');
          }
        } catch {
          // The cross-check is best-effort; health verdict stands if the event line is unavailable.
        }
      }

      // Credential vault gates only lanes that actually consume credentials. Pure/status paths are
      // deliberately independent of it, but the degraded capability must still be visible.
      let vault: any;
      try {
        const res: any = await ctx.client.masterApi('GET', '/vault/health');
        const status = String(res?.status ?? (res?.healthy === true ? 'UP' : '')).toUpperCase();
        vault = { reachable: true, status: status || 'UNKNOWN', ...(res?.backend ? { backend: res.backend } : {}) };
        if (status && !['UP', 'OK', 'READY', 'HEALTHY', 'DISABLED'].includes(status)) {
          problems.push(`credential vault reports ${status} — credential-dependent lanes fail closed until it recovers`);
        }
        // The consequence, not just the cause: lanes the master is CURRENTLY withholding because
        // their credentials cannot be resolved. This can be non-zero even with the vault UP (a
        // credential-referencing lane with nothing stored), and it is the answer to "my command
        // lanes are RUNNING with a full queue but never fire".
        if (typeof res?.withheldLaneCount === 'number' && res.withheldLaneCount > 0) {
          vault.withheldLaneCount = res.withheldLaneCount;
          vault.withheldLanes = res.withheldLanes;
          const names = (res.withheldLanes ?? [])
            .slice(0, 5)
            .map((l: any) => `${l.modelId}/${l.transitionId}`)
            .join(', ');
          problems.push(
            `${res.withheldLaneCount} credential-dependent lane(s) are withheld from execution (${names}${res.withheldLaneCount > 5 ? ', …' : ''}) — ` +
              'they resume automatically once credentials resolve; reasons in vault.withheldLanes, per-lane view in scheduler_status (eligibility CREDENTIALS_WITHHELD)',
          );
        }
      } catch (err: any) {
        // A 404 means this master predates the vault health endpoint, not that the vault is down.
        if (err?.name === 'GatewayError' && err.status === 404) {
          vault = { reachable: null, status: 'UNKNOWN', note: 'master exposes no /vault/health — cannot verify this layer' };
        } else {
          vault = { reachable: false, status: 'UNREACHABLE', error: String(err?.message ?? err).slice(0, 120) };
          problems.push(
            'credential vault did not answer — credential-dependent lanes fail closed; ' +
              'check agentic-net-vault and its OpenBao backend',
          );
        }
      }

      // External fires — the lanes THIS session is the runtime for. Without a server-side
      // provider these never fire on their own, not even with a schedule armed, so a backlog
      // here is invisible everywhere else: the lane looks healthy, the tokens just sit.
      // Surfacing it in readiness is what makes "connect a client" the moment work resumes.
      let externalFires: any;
      const llmDisabled = String(llm?.status ?? '').toUpperCase() === 'DISABLED';
      if (entry) {
        try {
          const res: any = await ctx.client.masterApi('GET', '/transitions/external/ready', undefined, {
            modelId: model,
            // The full roster is a per-lane binding sweep, so only pay for it when master
            // genuinely cannot run AI lanes — that is exactly when the wider view matters.
            ...(llmDisabled ? { includeAll: 'true' } : {}),
          });
          const rows: any[] = res?.transitions ?? [];
          const waiting = rows.filter((t: any) => t.ready && t.servable !== false);
          // Lanes master cannot run at all. Distinct from `waiting`: a stranded lane may be
          // running and look perfectly healthy on every other surface while going nowhere.
          // CLI_BINARY_MISSING strands a lane exactly like a missing provider does.
          const stranded = rows.filter((t: any) =>
            t.servableReason === 'MASTER_HAS_NO_PROVIDER' || t.servableReason === 'CLI_BINARY_MISSING');
          externalFires = {
            external: rows.length,
            waiting: waiting.length,
            ...(stranded.length
              ? {
                  stranded: stranded.length,
                  strandedTransitions: stranded.map((t: any) => ({
                    transitionId: t.transitionId, kind: t.kind, status: t.status,
                  })),
                }
              : {}),
            ...(waiting.length
              ? { transitions: waiting.map((t: any) => ({ transitionId: t.transitionId, kind: t.kind })) }
              : {}),
            note:
              'Each of these provider-backed llm/agent lanes does NOT run unattended and needs a connected client. Agent lanes whose '
              + 'executionBackend is headless-cli:claude/codex remain master-owned and can run unattended.',
          };
          if (waiting.length) {
            warnings.push(
              `${waiting.length} llm/agent lane(s) have work waiting for THIS session `
                + `(${waiting.map((t: any) => t.transitionId).slice(0, 5).join(', ')}`
                + `${waiting.length > 5 ? ', …' : ''}) — they do not fire while no client is connected. `
                + 'Offer to work them now: prepare_external_fire {transitionId} → answer as the host model → complete_external_fire.',
            );
          } else if (stranded.length) {
            warnings.push(
              `${stranded.length} llm/agent lane(s) exist that master cannot run (no provider / missing CLI binary): `
                + `${stranded.map((t: any) => t.transitionId).slice(0, 5).join(', ')}`
                + `${stranded.length > 5 ? ', …' : ''}. They are idle now, but nothing will ever run them `
                + 'except a connected client. list_external_fires {includeAll:true} shows the full picture.',
            );
          }
        } catch {
          // Old-master compatibility: no endpoint means no external-fire feature to report.
        }
      }
      if (llmDisabled) {
        const reachableClis = Object.entries((llm as any)?.headlessCliBinaries ?? {})
          .filter(([, ok]) => ok)
          .map(([name]) => name);
        llm = {
          ...llm,
          youAreTheRuntime:
            'No server-side model is configured (the intended Desktop Lite default). API-backed llm/agent '
            + 'lanes run only while an MCP client is connected and cannot be scheduled unattended. '
            + (reachableClis.length
              ? `A persona can still run unattended as an agent lane with llmMode:"bash" and binary:"${reachableClis.join('"|"')}" `
                + '(probed reachable by master), or as a one-shot command lane that pipes a prompt to a headless CLI. '
              : 'Master reaches NO headless CLI (claude/codex) either, so nothing reasons unattended until one is '
                + 'installed where Desktop/master runs or a provider is configured. ')
            + 'Configure a provider only when master should make API model calls.',
        };
      }

      // Executors — gate command lanes only.
      const executors = await fetchExecutors(ctx);
      const cov = coverageFromExecutors(executors, model);
      const covReport = {
        state: cov.state,
        available: cov.available,
        online: cov.online,
        eligible: cov.eligible,
        polling: cov.polling,
        covered: cov.covered,
        ...(cov.allowedButIdle.length ? { allowedButIdle: cov.allowedButIdle } : {}),
        ...(cov.state === 'STANDBY'
          ? { note: 'command-capable: assignment-driven discovery starts polling automatically after the first command lane is assigned' }
          : cov.state === 'UNAVAILABLE'
            ? { note: 'blocks COMMAND lanes only — map/llm/http/agent do not need an executor' }
            : {}),
      };

      return {
        ready: problems.length === 0,
        checkedAt: new Date().toISOString(),
        gateway,
        node,
        model: modelReport,
        llm,
        vault,
        executors: covReport,
        ...(externalFires ? { externalFires } : {}),
        capabilities: {
          build:
            gateway.authenticated === true &&
            node.reachable === true &&
            modelReport.exists === true,
          credentialLanes:
            vault?.reachable === true &&
            ['UP', 'OK', 'READY', 'HEALTHY', 'DISABLED'].includes(
              String(vault?.status ?? '').toUpperCase(),
            ),
          llmLanes: isLlmHealthReady(llm?.status) && llm?.usable !== false,
          // Probed by master (llm_health.headlessCliBinaries), not assumed: a tray-launched
          // master may not reach a CLI that works in every terminal. Absent on old masters
          // (which cannot run bash-mode agents at all) → false, which is also the truth.
          headlessCliAgents: Object.values(llm?.headlessCliBinaries ?? {}).some(Boolean),
          commandLanes: cov.available,
        },
        ...(problems.length ? { problems } : {}),
        ...(warnings.length ? { warnings } : {}),
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
      const res: any = await ctx.client.masterApi('GET', `/models/${model}/execution/status`, undefined, {
        modelId: model, // also as a query param: the gateway reads modelId from query/body, never the path
      });
      const list: any[] = res?.transitions ?? [];
      // Provider state decides whether a scheduled llm/agent lane can EVER fire on its own.
      // One extra GET; without it a nightly llm lane under a disabled provider reads as healthy.
      const llmHealth: any = await ctx.client.masterApi('GET', '/llm/health').catch(() => null);
      const providerDisabled = String(llmHealth?.status ?? '').toUpperCase() === 'DISABLED';
      // A bash-backed lane whose CLI master cannot reach is just as silent as a stranded one.
      const cliLaneStranded = (t: any) => {
        const backend = String(t.executionBackend ?? '');
        return backend.startsWith('headless-cli:')
          && llmHealth?.headlessCliBinaries?.[backend.slice('headless-cli:'.length)] === false;
      };
      const now = Date.now();
      const fmtAgo = (ms: number) => {
        const s = Math.max(0, Math.round((now - ms) / 1000));
        return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`;
      };
      let rows = list.map((t: any) => {
        const sched = t.schedule ?? null;
        const armedMs = sched?.armedAtMillis ?? null;
        const lastMs = sched?.lastFiredAtMillis ?? null;
        const successMs = sched?.lastSuccessAtMillis ?? null;
        const errorMs = sched?.lastErrorAtMillis ?? null;
        const nextMs = sched?.nextFireAtMillis ?? null;
        const running = String(t.status ?? '').toUpperCase() === 'RUNNING';
        // Two ways a schedule can be armed and yet dispatched by nobody. Either the lane is
        // `external` (master's schedulers skip it by design), or it is an AI lane and master has
        // no provider to run it with. Both display as a healthy armed cron otherwise.
        const external = String(t.status ?? '').toLowerCase() === 'external';
        const aiLane = t.kind === 'llm' || t.kind === 'agent';
        // Masters that expose requiresServerLlmProvider=false have identified a CLI-backed
        // agent. Older masters omit it, so undefined deliberately keeps the conservative rule.
        const providerBackedAiLane = aiLane && t.requiresServerLlmProvider !== false;
        const strandedAiLane = (providerDisabled && providerBackedAiLane && !external)
          || cliLaneStranded(t);
        const unattended = (external || strandedAiLane) && Boolean(sched);
        // "Overdue" means the scheduler should have fired and did not, which is advice to restart
        // the lane. That is wrong for a lane nothing was ever going to dispatch, so suppress it.
        const overdue = running && !unattended && typeof nextMs === 'number' && nextMs < now - 60_000;
        return {
          transitionId: t.transitionId,
          kind: t.kind,
          status: t.status,
          ready: t.ready,
          ...(unattended
            ? {
                willNotFireUnattended: true,
                // deliberately NOT `hint`: the overdue branch below owns that key, and one
                // diagnosis silently overwriting the other is how the real cause gets lost
                unattendedHint: external
                  ? 'This lane is `external`: master never fires it, so its schedule does NOT run while '
                    + 'no client is connected. A connected session must run it (prepare_external_fire → '
                    + 'complete_external_fire), or give master a provider and start_transition to hand it back.'
                  : `This is a ${t.kind} lane and master has no LLM provider, so its schedule cannot fire `
                    + 'server-side however it is armed. A connected session must run it '
                    + '(list_external_fires {includeAll:true} → prepare_external_fire → complete_external_fire), '
                    + 'or configure a provider so master can own the schedule.',
              }
            : {}),
          ...(t.eligibility ? { eligibility: t.eligibility } : {}),
          ...(t.credentialsWithheld
            ? {
                credentialsWithheld: t.credentialsWithheld,
                credentialsHint:
                  'The master is deliberately not assigning/executing this lane because its credentials cannot be resolved (vault outage, or a credential-referencing lane with nothing stored). It resumes automatically once credentials resolve — check readiness.vault and set_transition_credentials.',
              }
            : {}),
          schedule: sched,
          armedAt: typeof armedMs === 'number' ? new Date(armedMs).toISOString() : null,
          lastFiredAt: typeof lastMs === 'number' ? new Date(lastMs).toISOString() : null,
          ...(typeof lastMs === 'number' ? { lastFiredAgo: fmtAgo(lastMs) } : { neverFired: true }),
          lastSuccessAt: typeof successMs === 'number' ? new Date(successMs).toISOString() : null,
          lastErrorAt: typeof errorMs === 'number' ? new Date(errorMs).toISOString() : null,
          ...(typeof sched?.fireCount === 'number' ? { fireCount: sched.fireCount } : {}),
          ...(typeof sched?.successCount === 'number' ? { successCount: sched.successCount } : {}),
          // Per-origin split (V2-2): fireCount counts EVERY dispatch including manual fire_once,
          // so it cannot answer "did my schedule run". scheduledFireCount can.
          ...(typeof sched?.scheduledFireCount === 'number' ? { scheduledFireCount: sched.scheduledFireCount } : {}),
          ...(typeof sched?.manualFireCount === 'number' ? { manualFireCount: sched.manualFireCount } : {}),
          ...(typeof sched?.lastScheduledFireAtMillis === 'number'
            ? { lastScheduledFireAt: new Date(sched.lastScheduledFireAtMillis).toISOString() }
            : {}),
          ...(typeof sched?.lastScheduledSuccessAtMillis === 'number'
            ? { lastScheduledSuccessAt: new Date(sched.lastScheduledSuccessAtMillis).toISOString() }
            : {}),
          ...(typeof sched?.scheduledFireCount === 'number' && sched.scheduledFireCount === 0
            && typeof sched?.manualFireCount === 'number' && sched.manualFireCount > 0
            ? {
                scheduleNeverDispatched: true,
                scheduleHint: `the schedule itself has NEVER dispatched — all ${sched.manualFireCount} `
                  + 'fire(s) were manual fire_once calls. fireCount/lastFiredAt reflect those, not the schedule.',
              }
            : {}),
          ...(sched?.lastError != null ? { lastError: sched.lastError } : {}),
          ...(sched?.timezone != null ? { timezone: sched.timezone } : {}),
          ...(sched?.nextFireAtLocal != null ? { nextFireAtLocal: sched.nextFireAtLocal } : {}),
          ...(typeof sched?.valid === 'boolean' ? { valid: sched.valid } : {}),
          ...(sched?.invalidReason != null ? { invalidReason: sched.invalidReason } : {}),
          nextFireAt: typeof nextMs === 'number' ? new Date(nextMs).toISOString() : null,
          ...(overdue
            ? { overdue: true, hint: 'nextFireAt is in the past while RUNNING — the scheduler has not re-armed this lane (typical after a master redeploy). Restart this transition to re-register its schedule.' }
            : {}),
        };
      });
      if (args.scheduledOnly !== false) rows = rows.filter((r) => r.schedule);
      const overdueCount = rows.filter((r: any) => r.overdue).length;
      const allScheduled = list.filter((t: any) => t?.schedule);
      const stoppedScheduled = allScheduled
        .filter((t: any) => String(t.status ?? '').toUpperCase() !== 'RUNNING')
        .map((t: any) => ({ transitionId: t.transitionId, schedule: t.schedule }));
      const invalidSchedules = allScheduled
        .filter((t: any) => t.schedule?.valid === false)
        .map((t: any) => ({
          transitionId: t.transitionId,
          invalidReason: t.schedule?.invalidReason,
          schedule: t.schedule,
        }));
      // Count withheld lanes across ALL transitions, not just the scheduled subset — a withheld
      // unscheduled command lane must not vanish from this headline because of the default filter.
      const withheldCount = list.filter((t: any) => t.credentialsWithheld).length;
      // Scheduled but dispatched by nobody: armed on paper only. Called out separately from
      // stoppedScheduled because these statuses read as active states, not stopped ones.
      const externalScheduled = allScheduled
        .filter((t: any) => {
          const external = String(t.status ?? '').toLowerCase() === 'external';
          const aiLane = t.kind === 'llm' || t.kind === 'agent';
          const providerBackedAiLane = aiLane && t.requiresServerLlmProvider !== false;
          return external || (providerDisabled && providerBackedAiLane) || cliLaneStranded(t);
        })
        .map((t: any) => ({
          transitionId: t.transitionId,
          kind: t.kind,
          schedule: t.schedule,
          // Three distinct ways in, three distinct labels — a CLI-stranded lane blamed on the
          // provider sends the operator to the wrong fix (configure a provider vs install a binary).
          reason: String(t.status ?? '').toLowerCase() === 'external'
            ? 'MARKED_EXTERNAL'
            : cliLaneStranded(t)
              ? 'CLI_BINARY_MISSING'
              : 'MASTER_HAS_NO_PROVIDER',
        }));
      // A lane that fires on cadence, reports RUNNING and fails EVERY time still reads as healthy
      // in every other view here. A staging health probe did exactly that 691 times over 39 days.
      // Scanned across ALL transitions, not just the scheduled subset: the broken lane is often
      // the command lane downstream of the tick, which carries no schedule of its own.
      const failingLanes = list
        .filter((t: any) => Number(t.consecutiveFailures ?? 0) > 0 || t.neverSucceeded === true)
        .map((t: any) => ({
          transitionId: t.transitionId,
          kind: t.kind,
          consecutiveFailures: Number(t.consecutiveFailures ?? 0),
          neverSucceeded: t.neverSucceeded === true,
          lastError: t.lastError,
        }))
        .sort((a: any, b: any) => b.consecutiveFailures - a.consecutiveFailures);
      return {
        model,
        observedAt: res?.observedAt,
        count: rows.length,
        headline: {
          stoppedScheduled,
          invalidSchedules,
          ...(externalScheduled.length ? { externalScheduled } : {}),
          ...(failingLanes.length ? { failingLanes } : {}),
        },
        fieldGuide: {
          lifecycle: 'a scheduled lane that is STOPPED never fires; start_transition re-arms it',
          telemetry: 'armedAt means registered with the scheduler; lastFiredAt null means literally never dispatched; lastSuccessAt advances only after a successful outcome',
          invalid: 'INVALID_SCHEDULE lanes fail closed and never fire; fix the schedule, then set_schedule/start_transition',
          external: 'an `external` lane is fired by a connected client, never by master — its schedule does NOT run unattended',
          failing: 'consecutiveFailures counts failures SINCE the last success; neverSucceeded means it has fired but never once succeeded — a lane can be RUNNING, on cadence and completely broken',
        },
        ...(externalScheduled.length
          ? {
              externalScheduledCount: externalScheduled.length,
              externalScheduledHint:
                `${externalScheduled.length} scheduled lane(s) are external and will NOT fire on their own. `
                + 'Tell the user plainly: this work only happens while a client is connected. '
                + 'Run them now with prepare_external_fire, or configure a server-side LLM provider '
                + 'and start_transition to let master keep the schedule.',
            }
          : {}),
        ...(overdueCount ? { overdueCount } : {}),
        ...(withheldCount ? { credentialsWithheldCount: withheldCount } : {}),
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

  server.registerTool(
    'inspect_token_size',
    {
      title: 'Inspect token sizes before reading',
      description:
        'Measure token/property sizes without returning their content. Use first for command output, HTML, repository snapshots, or any place likely to contain large values; then choose query_tokens or extract_token_content.',
      inputSchema: {
        place: z.string().optional().describe('Place id or full path (alias: placeId)'),
        placeId: z.string().optional(),
        arcql: z.string().optional().describe('Default FROM $ LIMIT 20'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'inspect_token_size', mutates: false }, async (model, args) => {
      const place = String(args.place ?? args.placeId ?? '').trim();
      if (!place) throw new Error('provide place or placeId');
      const placePath = place.includes('/') ? place : `root/workspace/places/${place}`;
      const result = await ctx.executorFor(model).execute('INSPECT_TOKEN_SIZE', {
        placePath,
        ...(args.arcql ? { arcql: args.arcql } : {}),
      });
      if (!result.success) throw new Error(result.error ?? 'INSPECT_TOKEN_SIZE failed');
      return result.data;
    }),
  );

  server.registerTool(
    'extract_token_content',
    {
      title: 'Safely extract one large token',
      description:
        'Read and process one large token property without flooding the MCP response. auto strips noisy markup; text/head/window content; summarize uses the configured helper when available.',
      inputSchema: {
        place: z.string().optional().describe('Place id or full path (alias: placeId)'),
        placeId: z.string().optional(),
        tokenName: z.string(),
        mode: z.enum(['auto', 'summarize', 'text', 'links', 'structure', 'head']).optional(),
        property: z.string().optional().describe('Default body'),
        limit: z.number().optional().describe('Default 4000 chars'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'extract_token_content', mutates: false }, async (model, args) => {
      const place = String(args.place ?? args.placeId ?? '').trim();
      if (!place) throw new Error('provide place or placeId');
      const placePath = place.includes('/') ? place : `root/workspace/places/${place}`;
      const result = await ctx.executorFor(model).execute('EXTRACT_TOKEN_CONTENT', {
        placePath,
        tokenName: args.tokenName,
        ...(args.mode ? { mode: args.mode } : { mode: 'auto' }),
        ...(args.property ? { property: args.property } : {}),
        ...(args.limit != null ? { limit: args.limit } : {}),
      });
      if (!result.success) throw new Error(result.error ?? 'EXTRACT_TOKEN_CONTENT failed');
      return result.data;
    }),
  );

  server.registerTool(
    'read_blob_text',
    {
      title: 'Read offloaded blob text',
      description:
        'Fetch text behind a blob URN returned by command output, knowledge search, or token properties. Use searchFor to retrieve only relevant paragraphs and keep the MCP result bounded.',
      inputSchema: {
        blobUrn: z.string(),
        maxLength: z.number().optional().describe('Default 4000'),
        searchFor: z.string().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'read_blob_text', mutates: false }, async (model, args) => {
      const result = await ctx.executorFor(model).execute('READ_BLOB_TEXT', {
        blobUrn: args.blobUrn,
        ...(args.maxLength != null ? { maxLength: args.maxLength } : {}),
        ...(args.searchFor ? { searchFor: args.searchFor } : {}),
      });
      if (!result.success) throw new Error(result.error ?? 'READ_BLOB_TEXT failed');
      return result.data;
    }),
  );

  // diagnose_transition is registered on its own because for COMMAND transitions it augments the
  // master diagnosis with executor availability/activation — the one failure the master itself
  // cannot see. STANDBY is eligible and should become READY after assignment discovery;
  // UNAVAILABLE is a hard routing blocker.
  server.registerTool(
    'diagnose_transition',
    {
      title: 'Diagnose a transition',
      description:
        'Master-side diagnosis of why a transition is not firing (binding, preset ArcQL, token shape, live status), PLUS COMMAND executor state: READY, STANDBY pending automatic discovery, or UNAVAILABLE. No logs needed.',
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
        state: cov.state,
        available: cov.available,
        eligible: cov.eligible,
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

/** Provider implementations use READY (Ollama/CLI) or ONLINE (Claude/OpenAI) for healthy. */
export function isLlmHealthReady(status: any): boolean {
  return ['READY', 'ONLINE'].includes(String(status ?? '').toUpperCase());
}

export function evaluateLlmHealth(res: any): { report: any; problem?: string } {
  const status = String(res?.status ?? 'unknown').toUpperCase();
  if (status === 'DISABLED') {
    return {
      report: {
        ...res,
        capability: 'external-mcp-or-headless-cli',
        note:
          'Server-side LLM is intentionally disabled. Deterministic lanes remain available; master '
          + 'SKIPS provider-backed llm/agent lanes (they keep a normal status and wait), so serve those '
          + 'through this MCP client. CLI-backed agent lanes (llmMode:"bash", Claude Code/Codex) are the '
          + 'exception: master can run and schedule them unattended. `external` is set only by set_external; '
          + 'list_external_fires {includeAll:true} shows the provider-backed backlog.',
      },
    };
  }
  if (!isLlmHealthReady(status)) {
    return {
      report: {
        ...res,
        warning: `LLM provider is ${status} — master-run llm/agent transitions will fail until this is fixed (each retry billed).`,
      },
      problem: `LLM provider is ${status} — every master-run llm/agent fire fails until fixed (each backoff retry is a billed call)`,
    };
  }
  return { report: res };
}
