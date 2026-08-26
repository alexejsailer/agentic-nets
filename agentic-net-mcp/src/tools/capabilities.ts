/**
 * Capability delegation — the protocol half of "capability packs".
 *
 * A capability pack is an agent session (persona nets + deterministic pipelines + an
 * agent-manifest) that OWNS one operational domain server-side. Instead of a client pulling
 * schemas, docs and intermediate results into its own context to hand-roll a multi-step
 * operation, it finds a pack and delegates: one small task token in, one structured result
 * token out. The knowledge, the guards and the verification live in the net, shared by every
 * client of the stack — including weak and headless ones.
 *
 * Scoping rule (deliberate): packs are SYSTEM functionality, and the `default` model exists in
 * every Agentic-Nets install — so discovery looks in `default` unless the caller names a model.
 * An explicit `model` is validated against the connection allowlist as usual; the literal
 * `default` fallback is exempt, because reading capability METADATA from the system model is
 * the whole point of the registry (delegation itself still runs entirely server-side).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool, resolveModel } from '../scope.js';

/** The always-present system model that acts as the capability registry. */
const SYSTEM_MODEL = 'default';

/**
 * "explicit model wins, else the system model" — shared by both tools. args.model is validated
 * against the allowlist (a typo must not silently fall back to `default` and search the wrong
 * registry); absence means the system model, regardless of the connection's own default model.
 */
function targetModelFor(ctx: AppContext, args: Record<string, any>): string {
  const requested = args?.model;
  if (requested === undefined || requested === null || requested === '') return SYSTEM_MODEL;
  return resolveModel(ctx.scope, String(requested));
}

/** Compact one capability row: the list must stay cheap to read, never a manifest dump. */
function compactCapability(model: string, raw: any): Record<string, any> {
  const entry = raw?.entry ?? {};
  return {
    name: raw?.name ?? raw?.sessionId,
    displayName: raw?.displayName ?? raw?.name ?? raw?.sessionId,
    model,
    sessionId: raw?.sessionId,
    domain: raw?.domain ?? '',
    description: String(raw?.description ?? '').slice(0, 400),
    tags: raw?.tags ?? [],
    armed: raw?.armed ?? 'unknown',
    configReady: raw?.configReady !== false,
    entry: {
      inbox: entry?.inboxPlaceId ?? null,
      outbox: entry?.outboxPlaceId ?? null,
      correlationField: entry?.correlationField ?? 'requestId',
      howToUse: entry?.howToUse ?? '',
    },
  };
}

async function listCapabilities(ctx: AppContext, model: string): Promise<any[]> {
  const res: any = await ctx.client.masterApi('GET', `/installed-agents/${encodeURIComponent(model)}`);
  const rows: any[] = res?.agentSessions ?? (Array.isArray(res) ? res : []);
  return rows;
}

export function registerCapabilityTools(server: McpServer, ctx: AppContext): void {
  const config = ctx.config;
  const scope = ctx.scope;
  // With a single allowed model the other tools hide the `model` param entirely; here it stays,
  // because the whole point is reaching the system registry in `default` — but the description
  // must say what omitting it means.
  const modelParam = {
    model: z
      .string()
      .optional()
      .describe(
        `Where to look. Omit for the system capability registry (the '${SYSTEM_MODEL}' model, present in every install). ` +
          'Pass a model id to search a specific model instead (validated against this connection’s allowlist).',
      ),
  };

  server.registerTool(
    'find_capabilities',
    {
      title: 'Find capability packs to delegate to',
      description:
        'BEFORE hand-rolling a multi-step operation, check whether a capability pack already owns that domain: ' +
        'a server-side persona + deterministic pipeline that takes one task token and returns one verified result token, ' +
        'with its own policy guards and audit journal. This returns each pack’s name, domain, description, armed state ' +
        'and its delegation contract (entry inbox/outbox + correlation field). Searches the always-present `default` model ' +
        'unless `model` names another one. The contract is tag-based: a pack is an agent session tagged `agents` ' +
        '(usually also `capability-pack`) carrying an agent-manifest whose entry block names inbox/outbox/correlation. If a pack matches your task, use `delegate` instead of doing the steps yourself — ' +
        'it is cheaper (one call, no schemas or intermediate results in your context) and safer (the pack’s gates refuse ' +
        'what its policy forbids). Read agenticnets://docs/delegation for the concept.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter against name, domain, description and tags. Omit to list all.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'find_capabilities', mutates: false }, async (_model, args) => {
      const target = targetModelFor(ctx, args);
      let rows: any[];
      try {
        rows = await listCapabilities(ctx, target);
      } catch (e: any) {
        // A missing/unloaded registry model is an EMPTY answer, not an error — a fresh install
        // has no packs yet and the caller should simply proceed without delegation.
        return {
          model: target,
          count: 0,
          capabilities: [],
          note: `capability registry not readable in model '${target}' (${String(e?.message ?? e).slice(0, 120)}) — proceed without delegation`,
        };
      }
      const q = String(args.query ?? '').trim().toLowerCase();
      const all = rows.map((r) => compactCapability(target, r));
      const capabilities = q
        ? all.filter((c) =>
            [c.name, c.domain, c.description, ...(Array.isArray(c.tags) ? c.tags : [])]
              .join(' ')
              .toLowerCase()
              .includes(q),
          )
        : all;
      return {
        model: target,
        count: capabilities.length,
        capabilities,
        ...(capabilities.length
          ? { hint: 'Delegate with: delegate {capability: "<name>", request: "<plain English>"} — the result token comes back correlated.' }
          : {}),
      };
    }),
  );

  if (config.mode === 'readonly') return; // delegate writes a task token — rw only

  server.registerTool(
    'delegate',
    {
      title: 'Delegate a task to a capability pack',
      description:
        'Hand one task to a capability pack found via find_capabilities and wait for its verified result: writes a ' +
        'correlated task token into the pack’s entry inbox and awaits the reply on its outbox. The pack does the ' +
        'multi-step work server-side (its own preview/execute/verify pipeline, its own policy gates) and the result ' +
        'token carries the outcome — for the janitor pack e.g. status/before/deleted/after, where the counts are ' +
        'measured by the pipeline, not authored by a model. A timeout returns pending:true with the requestId — the ' +
        'pack is still working; await the outbox again with that requestId rather than re-delegating (a duplicate ' +
        'request doubles the work).',
      inputSchema: {
        capability: z.string().describe('Pack name or sessionId from find_capabilities (e.g. token-janitor)'),
        request: z.string().describe('The task in plain English, e.g. "empty p-fj-shipped in academy"'),
        fields: z
          .record(z.string())
          .optional()
          .describe('Optional extra flat string fields for the task token (e.g. {targetModel, place} when the pack’s input schema names them)'),
        requestId: z
          .string()
          .optional()
          .describe('Correlation id (generated when omitted). Reuse the SAME id to re-await a still-running delegation.'),
        timeoutMs: z.number().optional().describe('How long to wait for the result (default 120000, capped at 290000)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'delegate', mutates: true }, async (_model, args) => {
      const target = targetModelFor(ctx, args);
      const wanted = String(args.capability).trim().toLowerCase();
      const rows = await listCapabilities(ctx, target);
      const match = rows.find(
        (r) =>
          String(r?.name ?? '').toLowerCase() === wanted || String(r?.sessionId ?? '').toLowerCase() === wanted,
      );
      if (!match) {
        const known = rows.map((r) => r?.name ?? r?.sessionId).filter(Boolean);
        throw new Error(
          `capability '${args.capability}' not found in model '${target}'` +
            (known.length ? ` — available: ${known.join(', ')}` : ' — no packs installed there'),
        );
      }
      const cap = compactCapability(target, match);
      if (!cap.entry.inbox || !cap.entry.outbox) {
        throw new Error(`capability '${cap.name}' has no entry contract (inbox/outbox) in its agent-manifest — it cannot be delegated to`);
      }
      if (cap.armed === 'stopped') {
        throw new Error(
          `capability '${cap.name}' is installed but STOPPED — start it first (START_AGENT_SESSION / start its startPlan), then delegate`,
        );
      }
      const requestId = String(args.requestId ?? `del-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      const executor = ctx.executorFor(target);

      // Idempotent re-await: if a result for this requestId already exists (an earlier delegate
      // timed out after the pack finished), return it without writing a second task token.
      const corr = cap.entry.correlationField || 'requestId';
      const awaitArgs = {
        placePath: `root/workspace/places/${cap.entry.outbox}`,
        arcql: `FROM $ WHERE $.${corr}=="${requestId}" LIMIT 1`,
        timeoutMs: Math.min(Number(args.timeoutMs ?? 120000), 290000),
      };
      if (args.requestId) {
        const existing = await executor.execute('AWAIT_TOKEN', { ...awaitArgs, timeoutMs: 1500 });
        const hit: any = existing?.data;
        if (existing.success && hit?.matched) {
          return { capability: cap.name, model: target, requestId, result: hit.token?.data ?? hit.token, replayed: true };
        }
        // A re-awaited id whose task is still IN FLIGHT must not enqueue a duplicate: if the
        // task token is still waiting in the inbox (or leased by the persona), just await.
        const inFlight = await executor.execute('QUERY_TOKENS', {
          placePath: `root/workspace/places/${cap.entry.inbox}`,
          query: `FROM $ WHERE $.requestId=="${requestId}" LIMIT 1`,
          maxValueLength: 1,
        });
        const rows: any = inFlight?.data ?? {};
        const found = (Array.isArray(rows) ? rows : (rows.results ?? rows.tokens ?? [])).length > 0;
        if (found) {
          const res0 = await executor.execute('AWAIT_TOKEN', awaitArgs);
          const d0: any = res0?.data ?? {};
          if (res0.success && d0.matched) {
            return { capability: cap.name, model: target, requestId, result: d0.token?.data ?? d0.token };
          }
          return {
            capability: cap.name, model: target, requestId, pending: true,
            note: `the task is still in flight — re-await later with the same requestId "${requestId}".`,
          };
        }
        // No prior result and nothing in flight: fresh delegation under the caller's id.
      }
      const created = await executor.execute('CREATE_TOKEN', {
        placePath: `root/workspace/places/${cap.entry.inbox}`,
        name: `task-${requestId}`,
        data: { requestId, request: String(args.request), ...(args.fields ?? {}) },
      });
      if (!created.success) throw new Error(created.error ?? 'CREATE_TOKEN into the pack inbox failed');

      const res = await executor.execute('AWAIT_TOKEN', awaitArgs);
      if (!res.success) throw new Error(res.error ?? 'AWAIT_TOKEN failed');
      const data: any = res.data ?? {};
      if (!data.matched) {
        return {
          capability: cap.name,
          model: target,
          requestId,
          pending: true,
          note: `no result within ${awaitArgs.timeoutMs}ms — the pack may still be working. Re-await by calling delegate again with requestId "${requestId}" (it will NOT enqueue a duplicate), or query ${cap.entry.outbox} for ${corr}=="${requestId}".`,
        };
      }
      return { capability: cap.name, model: target, requestId, result: data.token?.data ?? data.token };
    }),
  );
}
