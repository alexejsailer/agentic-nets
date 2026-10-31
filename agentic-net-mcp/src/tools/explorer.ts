/**
 * Model Explorer reader: the model-wide designtime catalogue master builds for the Explorer page.
 *
 * One GET, readonly-safe. It is the only MCP view of the HIERARCHY of nets: a net's depth comes
 * from subnet refinement, where a transition (or place) of a parent net is refined by a child net
 * whose port places carry the SAME ids as the parent's preset/postset places. The abstract element
 * has no inscription and never fires; the runtime stays flat. Everything here is designtime data.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { notInstalled } from './refine.js';
import { refinementCall } from './refinement-routes.js';

const TOP_SHARED = 10;

/** A 404 from a master that lacks the route itself (Spring's default body), not from the read. */
/** The master's own error text from a GatewayError body (JSON or text). */
function errorText(err: any, fallback: string): string {
  let body: any = err?.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return body || fallback; } }
  return String(body?.error ?? body?.message ?? err?.message ?? fallback);
}

function routeMissing(err: any): boolean {
  if (err?.status !== 404) return false;
  const body = typeof err?.body === 'string' ? err.body : JSON.stringify(err?.body ?? '');
  return /"error"\s*:\s*"Not Found"/.test(body) && /"path"\s*:/.test(body);
}

/**
 * The model's structure under its neutral names (GET /api/models/{m}/structure[/facts|/chain|/scope]),
 * falling back to the Explorer page's routes on a master that predates them.
 */
async function structureGet(ctx: any, model: string, sub: '' | '/facts' | '/chain' | '/scope',
                            query: Record<string, string> = {}): Promise<any> {
  const m = encodeURIComponent(model);
  const q = new URLSearchParams({ modelId: model, ...query }).toString();
  try {
    return await ctx.master.get(`/models/${m}/structure${sub}?${q}`);
  } catch (err: any) {
    if (!routeMissing(err)) throw err;
    return await ctx.master.get(`/explorer/${m}${sub === '' ? '/catalogue' : sub}?${q}`);
  }
}

/** At most this many facts in the summary; detail:"full" returns all of them. */
const SUMMARY_FACTS = 60;

/** The structural facts as short lines (summary) or as served (full), narrowed to the matched nets. */
function factsOf(doc: any, detail: string, keys: Set<string> | null): Record<string, unknown> {
  const all: any[] = Array.isArray(doc?.facts) ? doc.facts : [];
  const facts = keys ? all.filter((f) => keys.has(String(f?.netKey))) : all;
  const counts: Record<string, number> = {};
  for (const f of facts) counts[String(f.kind)] = (counts[String(f.kind)] ?? 0) + 1;
  if (detail === 'full') return { total: facts.length, counts, facts };
  const line = (f: any) => {
    const extra = [f.element && `element ${f.element}`, f.child && `child ${f.child}`, f.status, f.parent && `parent ${f.parent}`,
      Array.isArray(f.skipped) && f.skipped.length ? `skips ${f.skipped.join(', ')}` : null].filter(Boolean).join(', ');
    return `${f.kind} ${f.subjectKey}${extra ? ` (${extra})` : ''}`;
  };
  return {
    total: facts.length,
    counts,
    lines: facts.slice(0, SUMMARY_FACTS).map(line),
    ...(facts.length > SUMMARY_FACTS ? { truncated: true, complete: false, more: facts.length - SUMMARY_FACTS, hint: 'detail:"full" returns every fact' } : { complete: true }),
  };
}

/** Subject key of a net, element, level or relation (section 22). */
export function subjectKindOf(key: string): 'relation' | 'element' | 'net' | 'level' {
  if (key.includes('>')) return 'relation';
  if (key.includes('#')) return 'element';
  if (key.includes('::')) return 'net';
  return 'level';
}

/**
 * The review of a model: every net with its state (confirmed, flagged, unconfirmed), its open flags
 * and open questions (own and on its elements), narrowed to a level or a net when asked. Nets
 * nobody marked are listed as unconfirmed, so a question round can start from what is untouched.
 */
export function reviewSummary(catalogue: any, review: any, opts: { level?: string; net?: string; needs?: string } = {}): any {
  const nets: any[] = Array.isArray(catalogue?.nets) ? catalogue.nets : [];
  const subjects: any[] = Array.isArray(review?.subjects) ? review.subjects : [];
  const bySubject = new Map<string, any>(subjects.map((s) => [String(s?.subjectKey ?? ''), s]));
  const wanted = nets.filter((n) => {
    if (opts.net && n?.key !== opts.net) return false;
    if (opts.level && (n?.layer ?? '') !== opts.level) return false;
    return true;
  });
  const rows = wanted.map((n) => {
    const key = String(n?.key ?? '');
    const own = bySubject.get(key);
    const elements: any[] = [];
    for (const [subjectKey, s] of bySubject) {
      if (!subjectKey.startsWith(`${key}#`)) continue;
      const flags = Array.isArray(s?.flags) ? s.flags : [];
      const questions = Array.isArray(s?.openQuestions) ? s.openQuestions : [];
      if (!flags.length && !questions.length && !s?.confirmed) continue;
      elements.push({
        elementId: subjectKey.slice(key.length + 1),
        state: s?.state ?? 'unconfirmed',
        flags: flags.map((f: any) => ({ markId: f?.markId, flag: f?.flag, reason: f?.reason, by: f?.by })),
        openQuestions: questions.map((q: any) => ({ promptId: q?.promptId, question: q?.question })),
      });
    }
    const flags = Array.isArray(own?.flags) ? own.flags : [];
    const questions = Array.isArray(own?.openQuestions) ? own.openQuestions : [];
    const openFlags = flags.length + elements.reduce((a, e) => a + e.flags.length, 0);
    const openQuestions = questions.length + elements.reduce((a, e) => a + e.openQuestions.length, 0);
    return {
      key,
      title: n?.title,
      level: n?.layer ?? null,
      responsible: n?.responsible ?? null,
      state: own?.state ?? 'unconfirmed',
      confirmed: own?.confirmed
        ? { by: own.confirmed.by, at: own.confirmed.at, revision: own.confirmed.revision ?? null, sourceHash: own.confirmed.sourceHash ?? null }
        : null,
      flags: flags.map((f: any) => ({ markId: f?.markId, flag: f?.flag, reason: f?.reason, by: f?.by })),
      openQuestions: questions.map((q: any) => ({ promptId: q?.promptId, question: q?.question })),
      elements,
      openFlags,
      openQuestionCount: openQuestions,
      needs: openFlags > 0 || openQuestions > 0 || !own?.confirmed,
    };
  });
  const needs = opts.needs ?? '';
  const filtered = rows.filter((r) => {
    switch (needs) {
      case 'flagged': return r.openFlags > 0;
      case 'questions': return r.openQuestionCount > 0;
      case 'unconfirmed': return !r.confirmed;
      case 'any': return r.needs;
      default: return true;
    }
  });
  const levelCounts: Record<string, { nets: number; confirmed: number; flagged: number; questions: number; unconfirmed: number }> = {};
  for (const r of rows) {
    const level = r.level ?? '(unassigned)';
    const c = (levelCounts[level] ??= { nets: 0, confirmed: 0, flagged: 0, questions: 0, unconfirmed: 0 });
    c.nets++;
    if (r.confirmed) c.confirmed++; else c.unconfirmed++;
    if (r.openFlags) c.flagged++;
    if (r.openQuestionCount) c.questions++;
  }
  return {
    modelId: catalogue?.modelId,
    curation: review?.curation ?? { installed: false },
    interview: review?.interview ?? { installed: false, supportsSubjects: false },
    counts: review?.counts ?? {},
    levels: levelCounts,
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.net ? { net: opts.net } : {}),
    ...(needs ? { needs } : {}),
    nets: filtered.map(({ needs: _needs, ...r }) => r),
    matched: filtered.length,
    total: rows.length,
    // Marks and questions go through curate_model (the refinement's guarded actions).
    markWith: {
      tool: 'curate_model',
      confirm: { action: 'confirm', input: { markId: '<unique>', subjectKind: 'net|element|level|relation', subjectKey: '<key>', by: '<who>', revision: '<definition revision>', note: '<optional>', sourceHash: '<optional>' } },
      flag: { action: 'flag', input: { markId: '<unique or deterministic>', subjectKind: '...', subjectKey: '<key>', flag: 'stale|unclear|wrong|contradiction|unmeasured|too-coarse|level-below-changed|level-above-changed', reason: '<what was measured or read>', by: '<who>' } },
      resolve: { action: 'resolve', input: { markId: '<the flag>', how: 'changed|confirmed|withdrawn', by: '<who>' } },
      ask: { action: 'ask', subjectKey: '<session>::<net> or <session>::<net>#<elementId> or <level id>', question: '<the question>', evidence: ['<what was read>'], reasoning: '<the argument>', options: ['<value or {value,label,description,recommended}>'] },
    },
  };
}

function matches(net: any, query: string): boolean {
  const q = query.toLowerCase();
  const tags: unknown[] = Array.isArray(net?.tags) ? net.tags : [];
  return [net?.key, net?.title, net?.description, net?.domain, net?.responsible, ...tags]
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

/** Organization and execution fields, only when the master sends them (older masters do not). */
function organizationOf(net: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (typeof net?.domain === 'string' && net.domain) out.domain = net.domain;
  if (typeof net?.responsible === 'string' && net.responsible) out.responsible = net.responsible;
  if (Array.isArray(net?.tags) && net.tags.length) out.tags = net.tags;
  if (typeof net?.execution?.state === 'string') out.execution = net.execution.state;
  return out;
}

function organizationSuffix(net: any): string {
  const o = organizationOf(net);
  const parts: string[] = [];
  if (o.domain) parts.push(`domain ${o.domain}`);
  if (o.responsible) parts.push(`responsible ${o.responsible}`);
  if (o.tags) parts.push(`tags ${o.tags.join('/')}`);
  if (o.execution) parts.push(`execution ${o.execution}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

function degree(place: any): number {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return n(place?.drawnIn) + n(place?.readers) + n(place?.writers);
}

/** Indented hierarchy lines: roots at depth 0, each child under its parent via the refining element. */
export function hierarchyLines(catalogue: any): string[] {
  const nets: any[] = Array.isArray(catalogue?.nets) ? catalogue.nets : [];
  const byKey = new Map<string, any>(nets.map((n) => [String(n?.key ?? ''), n]));
  const edges: any[] = Array.isArray(catalogue?.hierarchy) ? catalogue.hierarchy : [];
  const parentOf = new Map<string, any>();
  for (const e of edges) {
    if (e?.childKey) parentOf.set(String(e.childKey), e);
  }
  const children = new Map<string, string[]>();
  for (const n of nets) {
    const key = String(n?.key ?? '');
    const edge = parentOf.get(key);
    const parentKey = edge?.parent?.sessionId && edge?.parent?.netId
      ? `${edge.parent.sessionId}::${edge.parent.netId}`
      : typeof edge?.parent === 'string' ? edge.parent : null;
    const bucket = parentKey && byKey.has(parentKey) ? parentKey : '';
    if (!children.has(bucket)) children.set(bucket, []);
    children.get(bucket)!.push(key);
  }
  const out: string[] = [];
  const visit = (key: string, depth: number, seen: Set<string>) => {
    if (seen.has(key)) return;
    seen.add(key);
    const net = byKey.get(key);
    const edge = parentOf.get(key);
    const via = edge?.elementId ? `, via ${edge.elementId}` : '';
    const verified = edge?.verified ? `, ${edge.verified}` : '';
    const status = net?.definitionStatus && net.definitionStatus !== 'realized'
      ? `, definition ${net.definitionStatus}` : '';
    out.push(`${'  '.repeat(depth)}${key} (depth ${net?.depth ?? depth}${via}${verified}${status}${organizationSuffix(net)})`);
    for (const child of children.get(key) ?? []) visit(child, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const root of children.get('') ?? []) visit(root, 0, seen);
  // Nets whose parent is unknown to the catalogue still get listed, never silently dropped.
  for (const n of nets) visit(String(n?.key ?? ''), 0, seen);
  return out;
}

/** `fromKey relation toKey` per explicit relation, "(missing)" when the target net is gone. */
export function relationLines(catalogue: any, keys?: Set<string>): string[] {
  const all: any[] = Array.isArray(catalogue?.relations) ? catalogue.relations : [];
  return all
    .filter((r) => typeof r?.fromKey === 'string' && typeof r?.relation === 'string')
    .filter((r) => !keys || keys.has(r.fromKey) || keys.has(String(r?.toKey ?? '')))
    .map((r) => `${r.fromKey} ${r.relation} ${r?.toKey ?? '?'}${r?.resolved === false ? ' (missing)' : ''}`);
}

export function summarize(catalogue: any, query?: string): any {
  const allNets: any[] = Array.isArray(catalogue?.nets) ? catalogue.nets : [];
  const nets = query ? allNets.filter((n) => matches(n, query)) : allNets;
  const places: any[] = Array.isArray(catalogue?.places) ? catalogue.places : [];
  const topSharedPlaces = places
    .filter((p) => p?.shared === true || (Array.isArray(p?.drawnIn) && p.drawnIn.length > 1))
    .sort((a, b) => degree(b) - degree(a))
    .slice(0, TOP_SHARED)
    .map((p) => ({
      placeId: p?.ref?.placeId ?? p?.placeId,
      label: p?.label,
      drawnIn: Array.isArray(p?.drawnIn) ? p.drawnIn.length : 0,
      readers: Array.isArray(p?.readers) ? p.readers.length : 0,
      writers: Array.isArray(p?.writers) ? p.writers.length : 0,
    }));
  return {
    modelId: catalogue?.modelId,
    stats: catalogue?.stats ?? {},
    levels: Array.isArray(catalogue?.levels) ? catalogue.levels : [],
    hierarchy: hierarchyLines(query ? { ...catalogue, nets } : catalogue),
    // Explicit relations (explains, depends-on, references); older masters send none.
    ...(Array.isArray(catalogue?.relations)
      ? { relations: relationLines(catalogue, query ? new Set(nets.map((n) => String(n?.key ?? ''))) : undefined) }
      : {}),
    nets: nets.map((n) => ({
      key: n?.key,
      title: n?.title,
      depth: n?.depth,
      placeCount: n?.placeCount,
      transitionCount: n?.transitionCount,
      inscribedTransitionCount: n?.inscribedTransitionCount,
      definitionStatus: n?.definitionStatus,
      ...organizationOf(n),
    })),
    ...(query ? { query, matched: nets.length, total: allNets.length } : {}),
    topSharedPlaces,
    warnings: Array.isArray(catalogue?.warnings) ? catalogue.warnings : [],
  };
}

export function registerExplorerReaders(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'explore_model',
    {
      title: 'Explore a model as a hierarchy of nets',
      description:
        'Model-wide designtime catalogue: every net across every session with its qualified identity `session::netId` (two sessions may each own a net called main; the key tells them apart), its depth in the abstraction hierarchy, its interface (input/output/internal places), shared places with inscription-derived readers and writers, and natural-language definitions that have no topology yet. '
        + 'Depth comes from subnet refinement: a transition (or place) of a parent net is refined by a child net whose port places carry the SAME ids as the parent\'s preset/postset places, so the runtime stays flat and the abstract element never fires (it carries no inscription). '
        + 'Nets carry organization (domain, responsible, tags; set with update_net_definition action:"organize") and an execution state read from the existing transition statuses (none, running, partial, stopped, error). '
        + 'Explicit relations between nets (explains, depends-on, references; set with action:"relate") appear as lines "from relation to", marked (missing) when the target is gone. '
        + 'detail:"summary" (default) returns counts, levels, the hierarchy as indented lines, a compact net list and the most shared places; detail:"full" returns the whole document. query filters nets by key, title, description, domain, responsible or tags. '
        + 'facts:true adds the structural facts (what holds about the layering, without wording: unrefined-step = an abstract step without inscription that nothing refines, refined-inscribed = a refined step that still has an inscription and would run, refinement-unverified, below-nothing, level-order = a child not below its parent, level-gap = a child skipping levels). '
        + 'slice answers one feature across its levels instead of the catalogue (domain:<d>, tag:<t>, net:<session::net> for the net and everything below it, or a bare word; comma-separated for a union): its nets per level, the nets around it and how they connect, the levels it has no net of its own on, the shared places. '
        + 'chain (a net key) answers the net and the nets above it up to the top, each with the element it refines. Read-only; nothing here touches runtime state.',
      inputSchema: {
        detail: z.enum(['summary', 'full']).default('summary'),
        query: z.string().optional().describe('Substring filter on net key, title, description, domain, responsible or tags'),
        facts: z.boolean().optional().describe('Add the structural facts of the (matched) nets'),
        slice: z.string().optional().describe('One feature across its levels: domain:<d>, tag:<t>, net:<session::net> or a bare word; comma-separated for a union'),
        chain: z.string().optional().describe('A net key (session::netId): its chain up to the top'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'explore_model', mutates: false }, async (model, args) => {
      if (args.chain) {
        try {
          return await structureGet(ctx, model, '/chain', { net: args.chain });
        } catch (err: any) {
          if (err?.status === 404 || err?.status === 400) {
            return { available: false, model, net: args.chain, error: String(err?.message ?? ''), hint: 'an unknown net key (see explore_model), or a master without the chain read (upgrade master)' };
          }
          throw err;
        }
      }
      if (args.slice) {
        try {
          return await structureGet(ctx, model, '/scope', { scope: args.slice });
        } catch (err: any) {
          if (err?.status === 404) {
            return { available: false, model, error: String(err?.message ?? ''), hint: 'an unknown model, or a master without the slice read (upgrade master)' };
          }
          throw err;
        }
      }
      let catalogue: any;
      try {
        catalogue = await structureGet(ctx, model, '');
      } catch (err: any) {
        if (err?.status === 404 && !routeMissing(err)) {
          return { available: false, model, reason: 'not-found', hint: errorText(err, `model ${model} not found`) };
        }
        if (err?.status === 503) {
          // The node is still loading the model (after a restart): nothing of it is known yet.
          return { available: false, model, loading: true, hint: errorText(err, 'the model is still loading') + '; ask again in a few seconds' };
        }
        if (err?.status === 404) {
          return {
            available: false,
            model,
            hint: 'master without /api/explorer: this master predates the Model Explorer read model; upgrade master or use net_overview per net',
          };
        }
        throw err;
      }
      let facts: Record<string, unknown> | undefined;
      if (args.facts) {
        const keys = args.query
          ? new Set<string>((Array.isArray(catalogue?.nets) ? catalogue.nets : []).filter((n: any) => matches(n, args.query!)).map((n: any) => String(n.key)))
          : null;
        try {
          facts = factsOf(await structureGet(ctx, model, '/facts'), args.detail, keys);
        } catch (err: any) {
          if (err?.status !== 404) throw err;
          facts = { available: false, hint: 'master without /api/explorer/{model}/facts: upgrade master' };
        }
      }
      if (args.detail === 'full') {
        if (!args.query) return facts ? { ...catalogue, facts } : catalogue;
        const nets = (Array.isArray(catalogue?.nets) ? catalogue.nets : []).filter((n: any) => matches(n, args.query!));
        return { ...catalogue, nets, query: args.query, matched: nets.length, ...(facts ? { facts } : {}) };
      }
      const summary = summarize(catalogue, args.query);
      return facts ? { ...summary, facts } : summary;
    }),
  );

  server.registerTool(
    'review_model',
    {
      title: 'Review a model: what is confirmed, flagged or questioned',
      description:
        'The review state of a model\'s abstraction hierarchy (the refinement\'s marks and questions): per net, whether the person confirmed it, which flags are open (stale, unclear, wrong, contradiction, unmeasured, too-coarse, level-below-changed, level-above-changed), '
        + 'which questions are still open, and the same for its elements (subject key `session::net#elementId`). Nets nobody marked are listed as unconfirmed. '
        + 'Narrow with level (a level id), net (a key) or needs (any | flagged | questions | unconfirmed). The answer carries markWith: how to confirm, flag, resolve and ask through curate_model. '
        + 'Use it to start a question round (prompt question-round) or to see what a change in the referenced sources invalidated. Read-only.',
      inputSchema: {
        level: z.string().optional().describe('Only nets on this level (level id)'),
        net: z.string().optional().describe('Only this net (session::netId)'),
        needs: z.enum(['any', 'flagged', 'questions', 'unconfirmed']).optional().describe('Only nets that need the person in this way'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'review_model', mutates: false }, async (model, args) => {
      let catalogue: any;
      let review: any;
      try {
        [catalogue, review] = await Promise.all([structureGet(ctx, model, ''), refinementCall(ctx, 'GET', model, '/review')]);
      } catch (err: any) {
        { const ni = notInstalled(err, model); if (ni) return ni; }
        if (err?.status === 404 && !routeMissing(err)) {
          return { available: false, model, reason: 'not-found', hint: errorText(err, `model ${model} not found`) };
        }
        if (err?.status === 404) {
          return { available: false, model, hint: 'master without the review routes: upgrade master' };
        }
        throw err;
      }
      return reviewSummary(catalogue, review, { level: args.level, net: args.net, needs: args.needs });
    }),
  );
}
