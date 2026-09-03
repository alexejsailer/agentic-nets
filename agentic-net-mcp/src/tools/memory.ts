/**
 * Memory layer — the headline: Agentic-Nets as structured working memory.
 *
 * Conventions: memory places are `p-mem-{inbox|notes|decisions|knowledge|archive}`
 * in the runtime places container; short names are accepted everywhere. Tokens
 * carry `{kind:'memory', createdAt, source:'mcp', text?, ...data, tags?}` — the tool's
 * provenance defaults come FIRST so a same-named user data field always wins (field
 * finding F13b: `source` in user data was silently overwritten with 'mcp', and a
 * downstream template interpolated the wrong value). Explicit args (text/tags) still
 * override data, because the caller typed them deliberately.
 *
 * memory_write works WITHOUT the working-memory template deployed (it auto-creates
 * the runtime place); deploying the template later upgrades the very same places
 * with the always-on distiller — ids match by design.
 *
 * domain_memory_write / domain_memory_recall are the same idea against the model's
 * OWN durable memory base — the `p-{model}-domain-{knowledge|journal|insights}` places
 * of its domain net, which the master MEMORY_WRITE tool and the domain-expert persona
 * also use. So a memory written from Genesis, an agent, or the MCP is visible to all of
 * them. Added alongside p-mem-* (which is unchanged).
 */
import { z } from 'zod';
import { leaseOf } from './lease-util.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { buildLinkInscription, assignInscription } from '../inscriptions.js';
import { discoverLinkEdges, ensurePlacesContainer } from '../tree.js';

export const MEMORY_PLACES = ['inbox', 'notes', 'decisions', 'knowledge', 'archive'] as const;

export function resolveMemoryPlace(name?: string): string {
  const n = (name ?? 'notes').trim();
  if ((MEMORY_PLACES as readonly string[]).includes(n)) return `p-mem-${n}`;
  return n; // power users can target any runtime place verbatim
}

function placePath(placeId: string): string {
  return `root/workspace/places/${placeId}`;
}

/**
 * Token payload for memory_write. Provenance defaults come FIRST so a same-named user data
 * field always wins (field finding F13b: user `source` was silently replaced with 'mcp' and a
 * downstream template interpolated the wrong value). Explicit args (text/tags) still override
 * data, because the caller typed them deliberately.
 */
export function memoryTokenData(args: { text?: string; data?: Record<string, any>; tags?: string[] }): Record<string, any> {
  return {
    kind: 'memory',
    createdAt: new Date().toISOString(),
    source: 'mcp',
    ...(args.data ?? {}),
    ...(args.text ? { text: args.text } : {}),
    ...(args.tags?.length ? { tags: JSON.stringify(args.tags) } : {}),
  };
}

/** Same F13b merge order for domain_memory_write (adds content/type as explicit args). */
export function domainMemoryTokenData(args: {
  content?: string;
  data?: Record<string, any>;
  type?: string;
  tags?: string[];
}): Record<string, any> {
  return {
    kind: 'domain-memory',
    createdAt: new Date().toISOString(),
    source: 'mcp',
    ...(args.data ?? {}),
    ...(args.content ? { content: args.content } : {}),
    ...(args.type ? { type: args.type } : {}),
    ...(args.tags?.length ? { tags: JSON.stringify(args.tags) } : {}),
  };
}

/**
 * Readonly-safe token fetch: the gateway's readonly scope blocks POST (which is
 * how ArcQL travels), so plain reads go through the GET runtime endpoint instead.
 */
export async function fetchTokens(ctx: AppContext, model: string, placeId: string, size = 200): Promise<any[]> {
  const res = await ctx.client.masterApi('GET', `/runtime/places/${placeId}/tokens`, undefined, {
    modelId: model,
    size: String(size),
  });
  return res?.tokens ?? res?.results ?? [];
}

/**
 * Human-readable preview of a token: prefers text fields, and unwraps the
 * double-JSON-encoded `value` that llm-emitted tokens carry (engine quirk).
 */
export function previewOf(token: any): string {
  // Tokens come in two shapes: {data:{...}} (ArcQL results) and {data:{}, properties:{...}}
  // or {properties:{...}} (GET runtime endpoint / API-created) — read whichever has content.
  const d = token?.data && Object.keys(token.data).length ? token.data : undefined;
  const data = d ?? token?.properties ?? token ?? {};
  if (typeof data.text === 'string') return data.text.slice(0, 300);
  let v = data.value;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    const s = v.trim();
    if (!(s.startsWith('"') || s.startsWith('{') || s.startsWith('['))) break;
    try {
      v = JSON.parse(s);
    } catch {
      break;
    }
  }
  if (typeof v === 'string') return v.slice(0, 300);
  if (v && typeof v === 'object') {
    const firstString = Object.values(v).find((x) => typeof x === 'string') as string | undefined;
    if (firstString) return firstString.slice(0, 300);
    return JSON.stringify(v).slice(0, 300);
  }
  return JSON.stringify(data).slice(0, 300);
}

export async function ensurePlace(ctx: AppContext, model: string, placeId: string): Promise<void> {
  // Hot-path short-circuit: a place confirmed earlier this session needs no
  // re-check (the cache only ever avoids redundant work — see markPlaceKnown).
  if (ctx.placeKnown(model, placeId)) return;
  // Virgin models have no tree at all — build the container chain first so
  // memory_write works as the very first call ever made against a model.
  await ensurePlacesContainer(ctx, model);
  const res = await ctx.executorFor(model).execute('CREATE_RUNTIME_PLACE', { placeId });
  if (!res.success) throw new Error(`could not ensure place '${placeId}': ${res.error}`);
  ctx.markPlaceKnown(model, placeId);
}

export async function linkPlaces(
  ctx: AppContext,
  model: string,
  from: string,
  to: string,
  label: string,
  relation?: string,
): Promise<string> {
  await ensurePlace(ctx, model, from);
  await ensurePlace(ctx, model, to);
  const tid = `t-link-${from.replace(/^p-/, '')}-${to.replace(/^p-/, '')}`;
  const inscription = buildLinkInscription(tid, label, from, to, ctx.hostFor(model), relation);
  // Links are pure structure: assigned, NEVER started.
  await assignInscription(ctx, model, inscription, 'agentic-net-master');
  return tid;
}

export function registerMemoryTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'memory_write',
    {
      title: 'Write to working memory',
      description:
        'Store a memory token in a place. Places: inbox (raw capture), notes (default), decisions, knowledge, archive — or any custom place id. Optionally add typed links in the same call. For multiple durable domain/context stores, prefer a named net with link transitions; auto-created runtime places alone are not a complete semantic model.',
      inputSchema: {
        text: z.string().optional().describe('The memory as prose (stored as {text})'),
        data: z.record(z.any()).optional().describe('Structured fields to store alongside/instead of text'),
        place: z.string().optional().describe('inbox | notes | decisions | knowledge | archive | custom place id (default notes)'),
        tags: z.array(z.string()).optional(),
        links: z
          .array(z.object({
            to: z.string(),
            label: z.string().optional(),
            relation: z.string().optional().describe('What TARGET is to SOURCE: contains | references | derives-from | supersedes | promotes-to | ...'),
          }))
          .optional()
          .describe('Create typed semantic edges from the target place to related places (navigable via memory_graph)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'memory_write', mutates: true }, async (model, args) => {
      if (!args.text && !args.data) throw new Error('provide text and/or data');
      const placeId = resolveMemoryPlace(args.place);
      await ensurePlace(ctx, model, placeId);
      const data = memoryTokenData(args);
      const res = await ctx.executorFor(model).execute('CREATE_TOKEN', { placePath: placePath(placeId), data });
      if (!res.success) throw new Error(res.error ?? 'CREATE_TOKEN failed');
      const linked: string[] = [];
      for (const link of args.links ?? []) {
        const to = resolveMemoryPlace(link.to);
        linked.push(await linkPlaces(
          ctx,
          model,
          placeId,
          to,
          link.label ?? link.relation ?? `${placeId} relates to ${to}`,
          link.relation,
        ));
      }
      // Return a clean result — not the raw node event (version/eventResults/… is noise).
      return { stored: true, place: placeId, ...(linked.length ? { links: linked } : {}) };
    }),
  );

  server.registerTool(
    'memory_recall',
    {
      title: 'Recall from working memory',
      description:
        'Search memory places. Query forms: an ArcQL string starting with "FROM " (passed through, e.g. FROM $ WHERE $.kind=="memory" LIMIT 10), or a plain substring matched case-insensitively across token fields. Searches all memory places unless `place` narrows it.',
      inputSchema: {
        query: z.string().describe('ArcQL (starts with "FROM ") or a plain substring'),
        place: z.string().optional().describe('Limit to one place (short or full id)'),
        limit: z.number().optional().describe('Max matches to return (default 20)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'memory_recall', mutates: false }, async (model, args) => {
      const places = args.place
        ? [resolveMemoryPlace(args.place)]
        : MEMORY_PLACES.map((p) => `p-mem-${p}`);
      const isArcql = /^\s*FROM\s/i.test(args.query);
      const limit = args.limit ?? 20;
      const needle = String(args.query).toLowerCase();

      // Fetch every place concurrently (was N sequential round-trips), then merge
      // in deterministic place-order so results are stable across runs.
      const perPlace = await Promise.all(
        places.map(async (placeId) => {
          if (isArcql) {
            // ArcQL travels as POST — rw only; the gateway's readonly scope rejects it
            // (plain-substring queries work in both modes via the GET endpoint).
            const res = await ctx.executorFor(model).execute('QUERY_TOKENS', {
              placePath: placePath(placeId),
              query: args.query,
              maxValueLength: 400,
            });
            const toks = res.success
              ? (Array.isArray(res.data) ? res.data : (res.data?.results ?? res.data?.tokens ?? []))
              : [];
            return { placeId, tokens: toks };
          }
          return { placeId, tokens: await fetchTokens(ctx, model, placeId).catch(() => []) };
        }),
      );

      const matches: any[] = [];
      outer: for (const { placeId, tokens } of perPlace) {
        for (const t of tokens) {
          if (!isArcql && !JSON.stringify(t).toLowerCase().includes(needle)) continue;
          matches.push({ place: placeId, preview: previewOf(t), token: t });
          if (matches.length >= limit) break outer;
        }
      }
      return { query: args.query, matches, count: matches.length };
    }),
  );

  server.registerTool(
    'add_tokens',
    {
      title: 'Add many tokens to a place in one call',
      description:
        'Seed a place with up to 200 tokens in ONE call. Creating 100 tokens previously meant 100 memory_write round trips. Execution is sequential and NOT atomic — a failure does not roll back what already landed — so the result always reports created, failed and the index + reason of every failure, and stopOnError:true (default false) halts at the first one instead of pushing through. Each item is a plain object stored as the token data; pass text for prose, or arbitrary fields for structure.',
      inputSchema: {
        place: z.string().describe('Runtime place id (e.g. p-inbox); created if missing'),
        tokens: z.array(z.record(z.any())).min(1).max(200)
          .describe('One object per token — the token data itself'),
        stopOnError: z.boolean().optional()
          .describe('Stop at the first failure instead of continuing (default false)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'add_tokens', mutates: true }, async (model, args) => {
      const placeId = resolveMemoryPlace(args.place);
      await ensurePlace(ctx, model, placeId);
      const items: any[] = args.tokens ?? [];
      const stopOnError = args.stopOnError === true;
      const failures: Array<{ index: number; error: string }> = [];
      let created = 0;
      for (let i = 0; i < items.length; i++) {
        const res = await ctx.executorFor(model).execute('CREATE_TOKEN', {
          placePath: placePath(placeId),
          data: items[i],
        });
        if (res.success) {
          created++;
        } else {
          failures.push({ index: i, error: res.error ?? 'CREATE_TOKEN failed' });
          if (stopOnError) break;
        }
      }
      return {
        place: placeId,
        requested: items.length,
        created,
        failed: failures.length,
        // Partial writes are visible by construction: requested > created + failed means the run
        // stopped early, which only happens with stopOnError.
        ...(failures.length ? { failures } : {}),
        ...(created < items.length && stopOnError
          ? { stoppedEarly: true, notAttempted: items.length - created - failures.length }
          : {}),
      };
    }),
  );

  server.registerTool(
    'count_tokens',
    {
      title: 'Count tokens in a place',
      description:
        'How many tokens a place holds, without returning any of them. query_tokens had to ship token DATA just to answer "how many", which is the wrong trade for a place holding hundreds of large tokens. Pass arcql to count a subset (same grammar as query_tokens). Read-only, so it works in readonly mode.',
      inputSchema: {
        place: z.string().optional().describe('Runtime place id'),
        placeId: z.string().optional().describe('Alias of place — query_tokens and count_tokens accept either'),
        arcql: z.string().optional().describe('Optional selector; default counts every token'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'count_tokens', mutates: false }, async (model, args) => {
      const requested = args.place ?? args.placeId;
      if (!requested) throw new Error('count_tokens needs `place` (or its alias `placeId`)');
      const placeId = resolveMemoryPlace(requested);
      const arcql = String(args.arcql ?? 'FROM $').trim();
      // maxValueLength:1 keeps the wire payload to a stub per token — the count is the answer,
      // the values are not.
      const res = await ctx.executorFor(model).execute('QUERY_TOKENS', {
        placePath: placePath(placeId),
        query: arcql,
        maxValueLength: 1,
      });
      if (!res.success) throw new Error(res.error ?? 'QUERY_TOKENS failed');
      const raw: any = res.data ?? {};
      const tokens: any[] = Array.isArray(raw) ? raw : (raw.results ?? raw.tokens ?? []);
      return { place: placeId, arcql, count: tokens.length };
    }),
  );

  server.registerTool(
    'delete_tokens',
    {
      title: 'Delete tokens matched by an ArcQL query',
      description:
        'Query a place and delete the matched token ids in one bounded call. arcql is mandatory (there is no implicit full-place drain); max defaults to 100 and cannot exceed 100. Returns exact ids and per-id failures.',
      inputSchema: {
        place: z.string().describe('Runtime place id (e.g. p-inbox)'),
        arcql: z.string().min(1).describe('Required ArcQL selector, e.g. FROM $ WHERE $.status=="obsolete"'),
        max: z.number().int().min(1).max(100).optional().describe('Maximum deletions (default 100, hard cap 100)'),
        force: z.boolean().optional().describe('Also delete tokens LEASED by in-flight fires (default false: they are skipped and reported — deleting one breaks the holder\u2019s consumption)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'delete_tokens', mutates: true, destructive: true }, async (model, args) => {
      const arcql = String(args.arcql ?? '').trim();
      if (!/^FROM\s/i.test(arcql)) {
        throw new Error('arcql is required and must start with FROM; refusing an unscoped token drain');
      }
      const max = Math.min(Number(args.max ?? 100), 100);
      const placeId = resolveMemoryPlace(args.place);
      const query = await ctx.executorFor(model).execute('QUERY_TOKENS', {
        placePath: placePath(placeId),
        query: arcql,
        maxValueLength: 0,
      });
      if (!query.success) throw new Error(query.error ?? 'QUERY_TOKENS failed');
      const raw: any = query.data ?? {};
      const tokens: any[] = (Array.isArray(raw) ? raw : (raw.results ?? raw.tokens ?? [])).slice(0, max);
      // A leased token is held by an IN-FLIGHT fire: deleting it does not stop that work, it
      // just makes the fire's consumption fail afterwards (docs/leases — and exactly the
      // operator mistake that motivated this guard). Skip them unless force:true.
      const skippedLeased: Array<{ id: string; owner: string; expiresInMs: number }> = [];
      const deletable = args.force === true ? tokens : tokens.filter((t: any) => {
        const lease = leaseOf(t);
        if (!lease) return true;
        const id = String(t?._meta?.id ?? t?.id ?? t?.tokenId ?? 'unknown');
        skippedLeased.push({ id, owner: lease.owner, expiresInMs: lease.expiresInMs });
        return false;
      });
      const ids = deletable
        .map((t: any) => t?._meta?.id ?? t?.id ?? t?.tokenId)
        .filter((id: any) => id != null)
        .map(String);
      const deleted: string[] = [];
      const failures: Array<{ id: string; error: string }> = [];
      for (const id of ids) {
        const result = await ctx.executorFor(model).execute('DELETE_TOKEN', {
          placePath: placePath(placeId),
          tokenId: id,
        });
        if (result.success) deleted.push(id);
        else failures.push({ id, error: result.error ?? 'DELETE_TOKEN failed' });
      }
      return {
        place: placeId,
        matched: tokens.length,
        deleted: deleted.length,
        ids: deleted,
        ...(skippedLeased.length
          ? { skippedLeased, leasedNote: 'held by in-flight fires — stop_transition releases leases cleanly ONLY for a dead/wedged lane (a slow fire keeps a healthy lease; stopping it mid-fire invites a double-claim); pass force:true only if you accept breaking the holder\u2019s consumption' }
          : {}),
        ...(tokens.length !== ids.length ? { missingIdCount: tokens.length - ids.length } : {}),
        ...(failures.length ? { failures } : {}),
      };
    }),
  );

  server.registerTool(
    'clear_place',
    {
      title: 'Empty a place in one call',
      description:
        'Delete EVERY token in a place in ONE batch — the whole-place counterpart to delete_tokens, which is filtered but capped at 100 per call and deletes one token per round trip. Use this to reset a runaway sink; use delete_tokens when you need an ArcQL filter. The place itself survives (same id, same identity, empty) — arcs, inscriptions and in-flight emissions are untouched. Refuses while any token is LEASED by an in-flight fire unless force:true (docs/leases); pass expectCount to make the clear fail closed if the place does not hold exactly that many tokens.',
      inputSchema: {
        place: z.string().describe('Runtime place id (e.g. p-fj-shipped)'),
        force: z
          .boolean()
          .optional()
          .describe('Clear even while tokens are leased by in-flight fires (default false — deleting a leased token breaks the holder’s consumption)'),
        expectCount: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Safety interlock: only clear if the place holds exactly this many tokens (count_tokens first). Omit to clear whatever is there.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'clear_place', mutates: true, destructive: true }, async (model, args) => {
      const placeId = resolveMemoryPlace(args.place);

      // Lease pre-flight. A leased token is held by an IN-FLIGHT fire: deleting it does not stop
      // that work, it makes the fire's consumption fail afterwards. deleteAll on the master has no
      // lease awareness at all, so the guard has to live here — same contract as delete_tokens.
      // maxValueLength must stay generous: `_lock` is a JSON string and a truncated one parses as
      // "no lease", which would turn the guard into a rubber stamp.
      const scan = await ctx.executorFor(model).execute('QUERY_TOKENS', {
        placePath: placePath(placeId),
        query: 'FROM $',
        maxValueLength: 400,
      });
      if (!scan.success) throw new Error(scan.error ?? 'QUERY_TOKENS failed');
      const scanRaw: any = scan.data ?? {};
      const present: any[] = Array.isArray(scanRaw) ? scanRaw : (scanRaw.results ?? scanRaw.tokens ?? []);
      const leased = present
        .map((t: any) => ({ t, lease: leaseOf(t) }))
        .filter((x) => x.lease != null)
        .map((x) => ({
          id: String(x.t?._meta?.id ?? x.t?.id ?? x.t?.tokenId ?? 'unknown'),
          owner: x.lease!.owner,
          expiresInMs: x.lease!.expiresInMs,
        }));

      if (typeof args.expectCount === 'number' && present.length !== args.expectCount) {
        throw new Error(
          `expectCount ${args.expectCount} does not match the ${present.length} token(s) in ${placeId} — refusing to clear`,
        );
      }
      if (leased.length && args.force !== true) {
        throw new Error(
          `${leased.length} token(s) in ${placeId} are leased by in-flight fires (${[...new Set(leased.map((l) => l.owner))].join(', ')}). ` +
            'Wait for the fire, stop the lane, or pass force:true to clear anyway — see docs/leases.',
        );
      }

      // ONE call: master resolves the place, builds a deleteLeaf event per token and commits them
      // in a single node transaction (POST /api/runtime/places/{id}/tokens/deleteAll). Measured at
      // ~5000 tokens in 0.3s, versus ~500/min through the per-token DELETE_TOKEN path.
      const res: any = await ctx.client.masterApi(
        'POST',
        `/runtime/places/${encodeURIComponent(placeId)}/tokens/deleteAll`,
        undefined,
        { modelId: model },
      );
      const deletedCount = Number(res?.deletedCount ?? 0);
      return {
        place: placeId,
        deletedCount,
        placeRetained: true,
        ...(leased.length ? { forcedOverLeases: leased } : {}),
      };
    }),
  );

  // --- Domain memory: the model's OWN durable memory base, in its domain context ---
  // Same idea as memory_write/recall, but targeting the model-shared memory base the master's
  // MEMORY_WRITE and the domain-expert persona use, so a memory written from any of them is
  // visible to all of them. Added ALONGSIDE p-mem-* (unchanged). The store ROLE resolves through
  // the model's installed context manifest (GET /installed-contexts); the legacy
  // `p-{model}-domain-{store}` naming is the fallback — on the canonical path the master
  // materializes the domain skeleton AS a context whose stores point at those same places.
  const DOMAIN_STORES = ['knowledge', 'journal', 'insights'] as const;
  const domainPlace = (model: string, store: string): string => `p-${model}-domain-${store}`;
  const resolveDomainStore = (s?: string): (typeof DOMAIN_STORES)[number] => {
    const n = (s ?? 'knowledge').trim().toLowerCase();
    if ((DOMAIN_STORES as readonly string[]).includes(n)) return n as (typeof DOMAIN_STORES)[number];
    throw new Error(`store must be one of ${DOMAIN_STORES.join(', ')}`);
  };
  // role→placeId per model, ~30s TTL so hot write/recall paths don't rescan manifests.
  const domainStoreCache = new Map<string, { stores: Record<string, string>; expires: number }>();
  const resolveDomainPlace = async (model: string, store: string): Promise<string> => {
    const cached = domainStoreCache.get(model);
    if (cached && cached.expires > Date.now()) return cached.stores[store] ?? domainPlace(model, store);
    try {
      const res = await ctx.master.contexts(model);
      const list: any[] = Array.isArray(res) ? res : (res?.contexts ?? []);
      // model-scoped contexts win; within a scope the first-listed wins per role
      const ordered = [...list].sort(
        (a, b) => (a?.scope === 'model' ? 0 : 1) - (b?.scope === 'model' ? 0 : 1),
      );
      const stores: Record<string, string> = {};
      for (const context of ordered) {
        for (const s of context?.stores ?? []) {
          if (s?.role && s?.placeId && !(s.role in stores)) stores[s.role] = s.placeId;
        }
      }
      domainStoreCache.set(model, { stores, expires: Date.now() + 30_000 });
      return stores[store] ?? domainPlace(model, store);
    } catch {
      // no contexts endpoint / no installed context — legacy naming keeps working
      return domainPlace(model, store);
    }
  };

  server.registerTool(
    'domain_memory_write',
    {
      title: "Write to the model's domain memory base",
      description:
        "Persist a memory into THIS model's domain memory base — durable and shared, the same one the master MEMORY_WRITE tool and the domain-expert persona use. The store resolves through the model's installed context manifest (stores by role; legacy p-{model}-domain-{store} fallback). Store: knowledge (default, durable facts/capabilities), journal (what happened), insights.",
      inputSchema: {
        content: z.string().optional().describe('The memory as prose (stored as {content})'),
        data: z.record(z.any()).optional().describe('Structured fields to store alongside/instead of content'),
        store: z.string().optional().describe('knowledge (default) | journal | insights'),
        type: z.string().optional().describe('Optional item type/category'),
        tags: z.array(z.string()).optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'domain_memory_write', mutates: true }, async (model, args) => {
      if (!args.content && !args.data) throw new Error('provide content and/or data');
      const store = resolveDomainStore(args.store);
      const placeId = await resolveDomainPlace(model, store);
      // Context-resolved stores were created by the install/bootstrap; only the legacy
      // convention may need the place materialized on first use.
      if (placeId === domainPlace(model, store)) await ensurePlace(ctx, model, placeId);
      const data = domainMemoryTokenData(args);
      const res = await ctx.executorFor(model).execute('CREATE_TOKEN', { placePath: placePath(placeId), data });
      if (!res.success) throw new Error(res.error ?? 'CREATE_TOKEN failed');
      return { stored: true, store, place: placeId };
    }),
  );

  server.registerTool(
    'domain_memory_recall',
    {
      title: "Recall from the model's domain memory base",
      description:
        "Read memories previously stored in THIS model's domain memory base (store resolved via the installed context manifest, legacy p-{model}-domain-{store} fallback), newest first. Query: an ArcQL string starting with 'FROM ', or a plain substring matched across token fields.",
      inputSchema: {
        store: z.string().optional().describe('knowledge (default) | journal | insights'),
        query: z.string().optional().describe('ArcQL (starts with "FROM ") or a plain substring; omit for most-recent'),
        limit: z.number().optional().describe('Max matches (default 20)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'domain_memory_recall', mutates: false }, async (model, args) => {
      const store = resolveDomainStore(args.store);
      const placeId = await resolveDomainPlace(model, store);
      const limit = args.limit ?? 20;
      const query = (args.query ?? '').trim();
      const isArcql = /^\s*FROM\s/i.test(query);
      const needle = query.toLowerCase();
      let tokens: any[];
      if (isArcql) {
        const res = await ctx.executorFor(model).execute('QUERY_TOKENS', {
          placePath: placePath(placeId),
          query,
          maxValueLength: 400,
        });
        tokens = res.success
          ? (Array.isArray(res.data) ? res.data : (res.data?.results ?? res.data?.tokens ?? []))
          : [];
      } else {
        tokens = await fetchTokens(ctx, model, placeId).catch(() => []);
      }
      const matches: any[] = [];
      for (const t of tokens) {
        if (!isArcql && needle && !JSON.stringify(t).toLowerCase().includes(needle)) continue;
        matches.push({ place: placeId, preview: previewOf(t), token: t });
        if (matches.length >= limit) break;
      }
      return { store, place: placeId, matches, count: matches.length };
    }),
  );

  server.registerTool(
    'memory_link',
    {
      title: 'Link memory places',
      description:
        'Create a navigable knowledge-graph edge between two places (a kind:link transition — pure structure, it never fires). Traversed by memory_graph.',
      inputSchema: {
        from: z.string().describe('Source place (short or full id)'),
        to: z.string().describe('Target place (short or full id)'),
        label: z.string().optional().describe('Human-readable edge label, e.g. "decision derives from note"'),
        relation: z.string().optional().describe('Typed edge semantics (what TARGET is to SOURCE): relates | contains | references | derives-from | supersedes | promotes-to | archives-to | ... (open vocabulary)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'memory_link', mutates: true }, async (model, args) => {
      const from = resolveMemoryPlace(args.from);
      const to = resolveMemoryPlace(args.to);
      const tid = await linkPlaces(
        ctx, model, from, to, args.label ?? args.relation ?? `${from} -> ${to}`, args.relation);
      return { linked: true, from, to, relation: args.relation ?? 'relates', transitionId: tid };
    }),
  );

  server.registerTool(
    'memory_graph',
    {
      title: 'Walk the memory graph',
      description: 'Return the navigable context graph around a place: nodes (places with token counts) and labeled edges (link transitions).',
      inputSchema: {
        start: z.string().optional().describe('Start place (default inbox)'),
        depth: z.number().optional().describe('Traversal depth (default 2)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'memory_graph', mutates: false }, async (model, args) => {
      const start = resolveMemoryPlace(args.start ?? 'inbox');
      const depth = args.depth ?? 2;
      // Version-independent: link edges are read straight from the canonical
      // inscription leaves on node (no master graph endpoint required).
      const allEdges = await discoverLinkEdges(ctx, model);
      const adjacency = new Map<string, Set<string>>();
      for (const e of allEdges) {
        if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
        if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
        adjacency.get(e.from)!.add(e.to);
        adjacency.get(e.to)!.add(e.from); // navigable both ways
      }
      const reachable = new Set<string>([start]);
      let frontier = [start];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const n of frontier) {
          for (const m of adjacency.get(n) ?? []) {
            if (!reachable.has(m)) {
              reachable.add(m);
              next.push(m);
            }
          }
        }
        frontier = next;
      }
      const edges = allEdges.filter((e) => reachable.has(e.from) && reachable.has(e.to));
      const nodes = [] as any[];
      for (const p of reachable) {
        const count = await ctx.node.getChildrenCount(model, placePath(p)).catch(() => -1);
        nodes.push({ placeId: p, tokenCount: count });
      }
      return { start, depth, nodes, edges };
    }),
  );
}
