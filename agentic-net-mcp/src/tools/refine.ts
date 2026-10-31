/**
 * Top-down and bottom-up refinement of a model's abstraction hierarchy, as tools an MCP client
 * drives by itself (no server-side LLM needed, no prompt required):
 *
 * - `refine_model` (read-only): the worklist of a level or a net. Looking down: transitions nothing
 *   refines yet, refinements that do not verify, definitions still draft or ready. Looking up: nets
 *   with neither a parent nor an `explains` relation. Plus the review: open flags, open questions,
 *   subjects nobody confirmed. Every item carries a ready-made `ask` input, so the client can turn a
 *   gap into a question for the person in one call.
 * - `curate_model` (writes): ask, answer, confirm, flag, resolve, each a thin, validated wrapper over
 *   the refinement's guarded actions (core since master 2.62) with deterministic ids.
 *
 * Everything is designtime: nothing here starts a lane or spends quota.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { refinementAction, refinementCall, routeMissing } from './refinement-routes.js';

const FLAGS = ['stale', 'unclear', 'wrong', 'contradiction', 'unmeasured', 'too-coarse', 'level-below-changed', 'level-above-changed'] as const;

function cataloguePath(model: string): string {
  const m = encodeURIComponent(model);
  return `/explorer/${m}/catalogue?modelId=${m}`;
}

function worklistParams(args: { level?: string; net?: string; direction?: string; mode?: string; count?: number; for?: string; scope?: string; ring?: string; includeDeferred?: boolean }) {
  return { level: args.level, net: args.net, direction: args.direction, mode: args.mode, count: args.count,
    for: args.for, scope: args.scope, ring: args.ring, includeDeferred: args.includeDeferred ? 'true' : undefined };
}

const GROUND_NEXT = 'For each chain (prompt ground-model): read the bottom node\'s references from the sources, then check every node above against them, bottom-up. Agree: curate_model {action:"confirm", sourceHash}. A mechanical divergence (a name, a value, a count): update_net_definition or the specification, then confirm. A divergence that is a decision: curate_model {action:"flag", flag:"contradiction", evidence} on the node and {action:"ask"} with evidence, reasoning and options [keep the level as written | adopt what the sources do | both need a change]. Record the pass with scope "ground:<level>".';


const DIGEST_NEXT = 'Apply it top-down (prompt refinement-pass): revise the definitions the answers touch, create the child definitions the person asked for, resolve settled flags, rebuild from the specification when the model is spec-built, raise the next questions with curate_model {action:"ask"}, then record the pass with curate_model {action:"pass", consumedUntil: this digest\'s `until`}.';

/**
 * A master 404 that says an application is not installed in the model (code "not-installed"),
 * as opposed to a route this master does not have. The answer names the application to install.
 */
export function notInstalled(err: any, model: string): Record<string, unknown> | null {
  if (err?.status !== 404) return null;
  let body: any = null;
  try { body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body; } catch { body = null; }
  if (body?.code !== 'not-installed') return null;
  return {
    available: false,
    model,
    reason: 'not-installed',
    ...(body.application ? { application: body.application } : {}),
    hint: String(body.error ?? `not installed in ${model}`),
  };
}

/**
 * A 404 from the master is one of three answers: an application is not installed in the model (named; older masters), this master has
 * no such route (upgrade it), or the master's own "not found" (an unknown model, net or subject), passed on as
 * it is. Only the second one is about the master's version.
 */
export function missingAnswer(err: any, model: string, route: string): Record<string, unknown> | null {
  const ni = notInstalled(err, model);
  if (ni) return ni;
  if (err?.status !== 404) return null;
  if (routeMissing(err)) return { available: false, model, reason: 'route-missing', hint: `master without ${route}: upgrade master` };
  let body: any = null;
  try { body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body; } catch { body = null; }
  return { available: false, model, reason: 'not-found', hint: String(body?.error ?? err?.message ?? `not found in ${model}`) };
}

/** An application action refused because the application is not installed in the model: say which one and how to install it. */
function applicationMissing(err: any, model: string): Record<string, unknown> | null {
  if (err?.status !== 400 && err?.status !== 404) return null;
  const text = typeof err?.body === 'string' ? err.body : JSON.stringify(err?.body ?? '');
  const m = /application\s+'?([a-z0-9._-]+)'?\s+(?:is\s+)?not installed|no application\s+'?([a-z0-9._-]+)'?|unknown application\s+'?([a-z0-9._-]+)'?/i.exec(text);
  if (!m) return null;
  const name = m[1] ?? m[2] ?? m[3];
  return { available: false, model, reason: 'not-installed', application: name,
    hint: `${name} is not installed in ${model}: hub_install {name:"${name}", version:"latest", model:"${model}"}` };
}

export function scopePath(model: string, scope: string): string {
  const m = encodeURIComponent(model);
  const q = new URLSearchParams({ modelId: model, scope });
  return `/explorer/${m}/scope?${q.toString()}`;
}

const SCOPE_NEXT = 'Work inside the scope: refine_model {scope} for its cards (ring:"all" adds the open decisions of the nets around it), focus_digest {scope} for what the person answered about it, ground_model {scope} for its chains. Look around before asking: each open gap (a level the scope\'s chain passes without a net of its own) is settled by a definition on that level (update_net_definition {action:"create"}), or by curate_model {action:"confirm", subjectKey: the gap\'s subjectKey, notes: "covered by <net>" or "not needed: <why>"}; compare with the examples on that level (what other features have there) and with the neighbours (relations, shared places) for what the scope may be missing, and ask the person only what the sources cannot settle. Record the pass with scope = passScope.';

const WORKLIST_NEXT = 'curate_model {action:"ask", ...item.ask} sends a question to the person; {action:"answer"} records what they said and can confirm or flag the subject; {action:"confirm"|"flag"|"resolve"|"defer"} marks it directly.';

/** Interview subject kind for a subject key: a net, one of its elements, or a level. */
export function interviewSubjectKind(subjectKey: string): 'net-definition' | 'net-element' | 'level' {
  // A focus scope's own subjects (scope:<expr>, scope:<expr>@<level>) are level-like, even when the expression names a net.
  if (subjectKey.startsWith('scope:')) return 'level';
  if (subjectKey.includes('#')) return 'net-element';
  if (subjectKey.includes('::')) return 'net-definition';
  return 'level';
}

/** Curation subject kind for a subject key. */
export function curationSubjectKind(subjectKey: string): 'net' | 'element' | 'level' | 'relation' {
  if (subjectKey.startsWith('scope:')) return 'level';
  if (subjectKey.includes('>')) return 'relation';
  if (subjectKey.includes('#')) return 'element';
  if (subjectKey.includes('::')) return 'net';
  return 'level';
}

export function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

export interface RefineItem {
  kind: 'unrefined-transition' | 'refinement-not-ok' | 'definition-open' | 'no-parent' | 'open-flag' | 'open-question' | 'unconfirmed';
  direction: 'down' | 'up' | 'review';
  subjectKey: string;
  detail: string;
  /** A ready-made curate_model {action:"ask"} input (promptId filled in by the server when sent). */
  ask?: Record<string, unknown>;
  flag?: { markId: string; flag: string; reason?: string; by?: string };
  question?: { promptId: string; question: string };
}

const PRIORITY: Record<RefineItem['kind'], number> = {
  'open-flag': 0, 'refinement-not-ok': 1, 'open-question': 2, 'definition-open': 3,
  'unrefined-transition': 4, 'no-parent': 5, 'unconfirmed': 6,
};

/**
 * The worklist of a scope. Pure: the catalogue and the review come in, items go out, most pressing
 * first. `direction` keeps only the structural gaps looking that way ("review" items stay).
 */
export function refineWorklist(catalogue: any, review: any, opts: { level?: string; net?: string; direction?: 'down' | 'up' | 'both'; mode?: 'all' | 'review' | 'plan'; count?: number } = {}): any {
  const nets: any[] = Array.isArray(catalogue?.nets) ? catalogue.nets : [];
  const byKey = new Map<string, any>(nets.map((n) => [String(n?.key ?? ''), n]));
  const levels: any[] = Array.isArray(catalogue?.levels) ? catalogue.levels : [];
  const topLevel = levels.length ? String(levels[0]?.id ?? '') : '';
  const hierarchy: any[] = Array.isArray(catalogue?.hierarchy) ? catalogue.hierarchy : [];
  const relations: any[] = Array.isArray(catalogue?.relations) ? catalogue.relations : [];
  // Older catalogues carry only the ref on a definition; the key is derived then.
  const definitions = new Map<string, any>((Array.isArray(catalogue?.definitions) ? catalogue.definitions : [])
    .map((d: any) => [String(d?.key ?? (d?.ref?.sessionId && d?.ref?.netId ? `${d.ref.sessionId}::${d.ref.netId}` : '')), d]));
  const subjects = new Map<string, any>((Array.isArray(review?.subjects) ? review.subjects : []).map((s: any) => [String(s?.subjectKey ?? ''), s]));
  const direction = opts.direction ?? 'both';

  const refinedElements = new Map<string, Map<string, any>>();
  for (const edge of hierarchy) {
    const parentKey = edge?.parent?.sessionId && edge?.parent?.netId ? `${edge.parent.sessionId}::${edge.parent.netId}` : null;
    if (!parentKey) continue;
    if (!refinedElements.has(parentKey)) refinedElements.set(parentKey, new Map());
    refinedElements.get(parentKey)!.set(String(edge?.elementId ?? ''), edge);
  }
  const explains = new Set<string>(relations.filter((r) => r?.relation === 'explains').map((r) => String(r?.fromKey ?? '')));

  const wanted = nets.filter((n) => {
    if (n?.inline) return false;
    if (opts.net && n?.key !== opts.net) return false;
    if (opts.level && (n?.layer ?? '') !== opts.level) return false;
    // Application and persona nets are the work around the model, not the model: skip nets tagged app or persona.
    const tags: string[] = Array.isArray(n?.tags) ? n.tags : [];
    if (tags.includes('app') || tags.includes('persona')) return false;
    return true;
  });

  const items: RefineItem[] = [];
  const askFor = (subjectKey: string, question: string, options?: unknown[], extra: Record<string, unknown> = {}) => ({
    subjectKey, question, ...(options ? { options } : {}), ...extra,
  });
  for (const n of wanted) {
    const key = String(n?.key ?? '');
    const title = String(n?.title ?? key);
    const revision = definitions.get(key)?.revision ?? null;
    const refined = refinedElements.get(key) ?? new Map();
    if (direction !== 'up') {
      for (const elementId of (Array.isArray(n?.transitionIds) ? n.transitionIds : []) as string[]) {
        const edge = refined.get(elementId);
        if (!edge) {
          items.push({
            kind: 'unrefined-transition', direction: 'down', subjectKey: `${key}#${elementId}`,
            detail: `${title}: nothing refines ${elementId} at the level below`,
            ask: askFor(`${key}#${elementId}`, `In "${title}", what happens inside ${elementId}? Is it worth its own net one level down, is it a known gap, or is it as simple as it looks?`,
              ['refine it below', 'a known gap, leave it', 'as simple as it looks'], { header: 'Refine?', subjectRevision: revision }),
          });
        } else if (edge?.verified && edge.verified !== 'ok') {
          items.push({
            kind: 'refinement-not-ok', direction: 'down', subjectKey: `${key}#${elementId}`,
            detail: `${title}: the refinement of ${elementId} by ${edge.childKey} is ${edge.verified}${edge.details ? ` (${edge.details})` : ''}`,
          });
        }
      }
      const def = definitions.get(key);
      if (def && (def.status === 'draft' || def.status === 'ready')) {
        items.push({
          kind: 'definition-open', direction: 'down', subjectKey: key,
          detail: `${title}: definition ${def.status} (r${def.revision ?? 1}), nothing built yet`,
          ask: askFor(key, `"${title}" is still ${def.status}. Is the definition complete enough to build, or what is missing?`, undefined, { header: 'Definition', subjectRevision: revision, allowFreeText: true }),
        });
      }
    }
    if (direction !== 'down') {
      const level = n?.layer ?? '';
      if (!n?.parent && !explains.has(key) && level !== topLevel) {
        items.push({
          kind: 'no-parent', direction: 'up', subjectKey: key,
          detail: `${title}: no net above refines it and it explains nothing (level ${level || 'unassigned'})`,
          ask: askFor(key, `"${title}" hangs below nothing. Which net at the level above does it detail, or what does it explain?`, undefined, { header: 'Where above?', subjectRevision: revision, allowFreeText: true }),
        });
      }
    }
    const own = subjects.get(key);
    const elementSubjects = [...subjects.values()].filter((s) => String(s?.subjectKey ?? '').startsWith(`${key}#`));
    for (const s of [own, ...elementSubjects].filter(Boolean)) {
      for (const f of (Array.isArray(s.flags) ? s.flags : [])) {
        items.push({
          kind: 'open-flag', direction: 'review', subjectKey: String(s.subjectKey), detail: `${title}: ${f?.flag} (${f?.reason ?? ''})`,
          flag: { markId: String(f?.markId ?? ''), flag: String(f?.flag ?? ''), reason: f?.reason, by: f?.by },
        });
      }
      for (const q of (Array.isArray(s.openQuestions) ? s.openQuestions : [])) {
        items.push({
          kind: 'open-question', direction: 'review', subjectKey: String(s.subjectKey), detail: `${title}: open question "${q?.question ?? ''}"`,
          question: { promptId: String(q?.promptId ?? ''), question: String(q?.question ?? '') },
        });
      }
    }
    if (!own?.confirmed) {
      items.push({
        kind: 'unconfirmed', direction: 'review', subjectKey: key, detail: `${title}: nobody confirmed it yet`,
        ask: askFor(key, `Does "${title}" describe what it claims to describe${n?.description ? ` ("${String(n.description).slice(0, 160)}")` : ''}?`,
          ['right', 'partly', 'wrong', "don't know"], { header: 'Confirm?', subjectRevision: revision, allowFreeText: true }),
      });
    }
  }
  const mode = opts.mode ?? 'all';
  const reviewKinds = new Set<RefineItem['kind']>(['open-flag', 'open-question', 'unconfirmed']);
  if (mode !== 'all') {
    const kept = items.filter((i) => reviewKinds.has(i.kind) === (mode === 'review'));
    items.splice(0, items.length, ...kept);
  }
  items.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.subjectKey.localeCompare(b.subjectKey));
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const limited = opts.count && opts.count > 0 ? items.slice(0, opts.count) : items;
  return {
    modelId: catalogue?.modelId,
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.net ? { net: opts.net } : {}),
    direction,
    nets: wanted.length,
    counts,
    total: items.length,
    returned: limited.length,
    items: limited,
    next: 'curate_model {action:"ask", ...item.ask} sends a question to the person; {action:"answer"} records what they said and can confirm or flag the subject; {action:"confirm"|"flag"|"resolve"} marks it directly.',
  };
}

export function registerRefineReaders(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'refine_model',
    {
      title: 'Worklist for refining a model top-down and bottom-up',
      description:
        'What a level or a net still needs, as a prioritized worklist with ready-made questions: looking down, transitions nothing refines yet, refinements that do not verify (port mismatch, missing target), definitions still draft or ready; '
        + 'looking up, nets that neither hang below a parent nor explain another net; and the review: open flags, open questions, subjects nobody confirmed. '
        + 'Each item carries an `ask` input for curate_model {action:"ask"}, so a client can run a question round without a prompt or a server-side LLM. '
        + 'Scope with level (a level id) or net (session::netId); direction down | up | both; count caps the list. '
        + 'scope narrows it to one focus scope (a feature across its levels: domain:<d>, tag:<t>, net:<session::net>, comma-separated for a union; see focus_scope): its nets, plus a card per level its chain passes without a net of its own (kind scope-gap); ring:"all" adds the open questions and flags of the nets around it, ring:"near" only those. Read-only.',
      inputSchema: {
        level: z.string().optional().describe('Only nets on this level'),
        net: z.string().optional().describe('Only this net (session::netId)'),
        direction: z.enum(['down', 'up', 'both']).default('both'),
        mode: z.enum(['all', 'review', 'plan']).optional().describe('review: flags, questions, never confirmed (bottom-up); plan: open definitions, unrefined transitions, nets below nothing (top-down); default all'),
        for: z.enum(['person', 'model', 'all']).optional().describe('person: decisions only the person can take (open questions, open flags); model: structural gaps the AI settles from the sources (unrefined, unverified, draft, unconfirmed); default all'),
        count: z.number().int().positive().max(200).optional().describe('At most this many items (default: all)'),
        scope: z.string().optional().describe('A focus scope: domain:<d>, tag:<t>, net:<session::net> or a bare word, comma-separated for a union'),
        ring: z.enum(['core', 'near', 'all']).optional().describe('With scope: core = the scope and its level gaps (default); near = only the open decisions around it; all = both'),
        includeDeferred: z.boolean().optional().describe('Also the subjects deferred to a later date (each with deferredUntil)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'refine_model', mutates: false }, async (model, args) => {
      // The master computes the one worklist the Refine view and the scripts read too
      // (it also honours deferred subjects); an older master without the route gets the local fold.
      try {
        const served = await refinementCall(ctx, 'GET', model, '/worklist', undefined, worklistParams(args));
        if (served && Array.isArray(served.items)) {
          return { ...served, next: WORKLIST_NEXT };
        }
      } catch (err: any) {
        { const ni = notInstalled(err, model); if (ni) return ni; }
        if (err?.status !== 404) throw err;
        if (!routeMissing(err)) { const missing = missingAnswer(err, model, '/api/explorer/{model}/worklist'); if (missing) return missing; }
      }
      if (args.scope) {
        return { available: false, model, hint: 'master without focus scopes: upgrade master (refine_model without scope still works)' };
      }
      let catalogue: any;
      let review: any;
      try {
        [catalogue, review] = await Promise.all([ctx.master.get(cataloguePath(model)), refinementCall(ctx, 'GET', model, '/review')]);
      } catch (err: any) {
        { const missing = missingAnswer(err, model, '/api/explorer'); if (missing) return missing; }
        throw err;
      }
      return refineWorklist(catalogue, review, { level: args.level, net: args.net, direction: args.direction, mode: args.mode, count: args.count });
    }),
  );

  server.registerTool(
    'ground_model',
    {
      title: 'The chains from the bottom level up, with claims and confirmations',
      description:
        'The ground of a model: for every net on the bottom level (the one that touches the domain\'s own material: code, documents, data) or for one net, the chain of nets above it, each with its claims (description, interactions, acceptance), its references, its definition state and whether and at which source hash it was confirmed. '
        + 'A client reads the referenced sources and checks every level against them (prompt ground-model); where a level and the sources diverge it corrects the level or asks the person which is right. Read-only.',
      inputSchema: {
        level: z.string().optional().describe('The bottom level id (default: the lowest level of the model)'),
        net: z.string().optional().describe('One net (session::netId) instead of the whole level'),
        scope: z.string().optional().describe('Only the chains of a focus scope\'s own bottom nets (domain:<d>, tag:<t>, net:<session::net>)'),
        full: z.boolean().optional().describe('Repeat every node in full in every chain (default: a net already listed in an earlier chain repeats only its key, title, level, confirmation and sameAs)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'ground_model', mutates: false }, async (model, args) => {
      try {
        const served = await refinementCall(ctx, 'GET', model, '/ground', undefined, { level: args.level, net: args.net, scope: args.scope });
        return { ...(args.full ? served : compactChains(served)), next: GROUND_NEXT };
      } catch (err: any) {
        { const missing = missingAnswer(err, model, '/api/explorer/{model}/ground'); if (missing) return missing; }
        throw err;
      }
    }),
  );

  server.registerTool(
    'focus_digest',
    {
      title: 'What the person answered since the last refinement pass',
      description:
        'The digest of a model: every answer, confirmation, flag, resolution and deferral the person recorded (in the Explorer\'s Refine view or by curate_model) since the last refinement pass, grouped by level and subject, plus the questions still open. '
        + 'Question rounds and refinement passes alternate as often as needed: the digest starts after the newest `pass` record (curate_model {action:"pass"}) unless `since` is given. Read-only; `until` is the instant to hand back as consumedUntil when the pass is recorded.',
      inputSchema: {
        since: z.string().optional().describe('ISO-8601 instant; default: the last pass\'s consumedUntil, or everything when no pass was recorded'),
        level: z.string().optional().describe('Only subjects on this level'),
        scope: z.string().optional().describe('Only a focus scope\'s subjects (domain:<d>, tag:<t>, net:<session::net>); the digest then starts after the newest pass over the same scope or over the whole model'),
        ring: z.enum(['core', 'near', 'all']).optional().describe('With scope: all adds the subjects of the nets around it'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'focus_digest', mutates: false }, async (model, args) => {
      try {
        const served = await refinementCall(ctx, 'GET', model, '/digest', undefined, { since: args.since, level: args.level, scope: args.scope, ring: args.ring });
        return { ...served, next: DIGEST_NEXT };
      } catch (err: any) {
        { const missing = missingAnswer(err, model, '/api/explorer/{model}/digest'); if (missing) return missing; }
        throw err;
      }
    }),
  );
}

export function registerFocusScope(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};
  server.registerTool(
    'focus_scope',
    {
      title: 'One feature across its levels, and what surrounds it',
      description:
        'A focus scope: the part of a model to work on now, typically one feature across every level. scope is domain:<d>, tag:<t>, net:<session::net> (the net and everything below it) or a bare word, comma-separated for a union; nets below a matched net join when they carry no other domain. '
        + 'Answers the scope\'s nets per level (core), the nets around it and how each connects (parent, child, depends-on, explains, references and their inverses, shares-place; siblings, the chain above and hub places as context), '
        + 'the levels its chain passes without a net of its own (gaps, each with what covers the level in the chain and which other features sit there, each a subject to confirm, defer or ask about), the shared places on its boundary, and passScope for curate_model {action:"pass"}. Read-only.',
      inputSchema: {
        scope: z.string().min(1).describe('domain:<d>, tag:<t>, net:<session::net> or a bare word; comma-separated for a union'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'focus_scope', mutates: false }, async (model, args) => {
      try {
        const served = await ctx.master.get(scopePath(model, args.scope));
        // The slice is the core's. An older master served the refinement's tools only where Focus was installed.
        const focus = await refinementCall(ctx, 'GET', model, '/run').catch(() => null);
        if (focus && focus.state === 'not-installed') {
          return { ...served, focusInstalled: false,
            next: `This master runs the refinement as the Focus application, which is not installed in ${model}: the slice above is all there is. refine_model, focus_digest and the passes need it: hub_install {name:"refiner", version:"latest", model:"${model}"}.` };
        }
        return { ...served, next: SCOPE_NEXT };
      } catch (err: any) {
        { const missing = missingAnswer(err, model, '/api/explorer/{model}/scope'); if (missing) return missing; }
        throw err;
      }
    }),
  );
  for (const name of ['refinement_status', 'refiner_status']) server.registerTool(
    name,
    {
      title: name === 'refiner_status' ? 'Old name of refinement_status' : 'The refinement on a model: its lanes, MCP access, pending requests and the last runs',
      description: 'Read-only state of the refinement on the model: whether its package is installed yet (it installs itself on the first hand-over or round), whether the pass lane carries an MCP server, which LLM it thinks with, the runner settings and profiles, the MCP grant, whether a pass is running now, the pending requests and the last runs with their reports.',
      inputSchema: { ...modelParam },
    },
    wrapTool(scope, config.mode, { name, mutates: false }, async (model) => {
      try {
        const st = await refinementCall(ctx, 'GET', model, '/run');
        if (st && st.state === 'not-installed') {
          // An older master: the review method was the Focus application.
          return { available: false, model, reason: 'not-installed', application: 'refiner',
            hint: `This master runs the refinement as the Focus application, which is not installed in ${model}: hub_install {name:"refiner", version:"latest", model:"${model}"}` };
        }
        return st;
      } catch (err: any) {
        { const missing = missingAnswer(err, model, '/api/explorer/{model}/refinement/run'); if (missing) return missing; }
        throw err;
      }
    }),
  );

  server.registerTool(
    'subject_thread',
    {
      title: 'The planning thread of one subject',
      description: 'Everything said and decided about a subject in time order: the person\'s briefs, the AI\'s summaries, questions with their answers, own questions, confirmations, flags, resolutions, deferrals and the passes that touched it. Read-only. subject is session::net, session::net#element, a level id or a scope subject.',
      inputSchema: { subject: z.string().min(1), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'subject_thread', mutates: false }, async (model, args) => {
      try {
        return await refinementCall(ctx, 'GET', model, '/thread', undefined, { subject: args.subject });
      } catch (err: any) {
        { const missing = missingAnswer(err, model, '/api/explorer/{model}/thread'); if (missing) return missing; }
        throw err;
      }
    }),
  );
}

export function registerRefineTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  // `application` names where an older master kept the action (Curation or Interview); the core needs no name.
  const act = (model: string, application: string, action: string, input: Record<string, unknown>, idempotencyKey?: string) =>
    refinementAction(ctx, model, application, action, input, idempotencyKey);

  server.registerTool(
    'curate_model',
    {
      title: 'Ask, answer, confirm, flag or resolve on a model subject',
      description:
        'Writes of a question round, each a validated wrapper over the refinement\'s guarded actions with deterministic ids. '
        + 'ask: a question to the person about a subject (session::net, session::net#elementId, or a level id); the subject fields are derived from the key. A card needs substance: evidence (what was read or measured), reasoning (the argument and the recommendation) and options with a description each, one recommended. '
        + 'answer: record what the person said (selected and/or text) on a promptId; with then:"confirm" the subject is confirmed in the same call (by = the person), with then:"flag" it is flagged (flag + reason). '
        + 'confirm / flag / resolve / defer (until a date): write a mark directly (markId defaults to a deterministic id). '
        + 'pass: record a refinement pass (consumedUntil = the digest\'s `until`, summary, changes, questions raised), so the next focus_digest starts after it; a structure or ground pass records scope structure:... or ground:... and leaves the answers for the next refinement. '
        + 'raise: the person\'s own question about a subject (the digest lists it until a question carries its requestId). reshape: the person reshapes a question (respond with intent revise and the better wording; the next pass asks again). '
        + 'note: words about a subject: noteKind brief = what the person said about it in their own words (the next pass derives the definition from it), summary = what the AI understood, changed and left open after a pass (the person reads it on the card), decision = settled for good, finding = what the sources say now, written by a runner that read them (explain, look and diff write one). Nothing here starts anything.',
      inputSchema: {
        action: z.enum(['ask', 'answer', 'confirm', 'flag', 'resolve', 'defer', 'pass', 'raise', 'reshape', 'note']),
        noteKind: z.enum(['brief', 'summary', 'decision', 'finding']).optional().describe('note: brief (the person\'s words), summary (the AI\'s, after a pass), decision, finding (what the sources say, with where it says so (file and line, page, record))'),
        text: z.string().optional().describe('answer: free text; note: the words'),
        noteId: z.string().optional().describe('note: id (default derived)'),
        subjectKey: z.string().optional().describe('ask, confirm, flag, and answer with then: the subject'),
        question: z.string().optional().describe('ask: the question, in the person\'s words'),
        header: z.string().optional().describe('ask: short chip label'),
        context: z.string().optional().describe('ask: one line of background'),
        reasoning: z.string().optional().describe('ask: the argument behind the question: why it matters, the trade-off between the options, which one you recommend and why. The person argues with this'),
        evidence: z.array(z.string()).optional().describe('ask: what was read or measured, one item each with its finding (file and line, document, number); flag: files, lines, numbers, the person\'s words'),
        options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string(), description: z.string().optional(), recommended: z.boolean().optional() })])).optional(),
        multiSelect: z.boolean().optional(),
        allowFreeText: z.boolean().optional(),
        promptId: z.string().optional().describe('ask: id of the new prompt (default derived); answer: the prompt answered'),
        subjectRevision: z.number().int().optional().describe('ask/confirm: definition revision the question or confirmation is against'),
        selected: z.array(z.string()).optional().describe('answer: chosen option values'),
        notes: z.string().optional().describe('answer: a note beside the choice; confirm: why it is right'),
        respondedBy: z.string().optional().describe('answer: who answered (default "the person")'),
        then: z.enum(['confirm', 'flag']).optional().describe('answer: also confirm or flag subjectKey'),
        by: z.string().optional().describe('confirm/flag/resolve/pass: who (default "the person")'),
        flag: z.enum(FLAGS).optional().describe('flag, or answer with then:"flag"'),
        reason: z.string().optional().describe('flag: what was measured or read'),
        sourceHash: z.string().optional().describe('confirm: hash of the referenced sources at this moment'),
        markId: z.string().optional().describe('confirm/flag: id of the new mark (default deterministic); resolve: the flag'),
        how: z.enum(['changed', 'confirmed', 'withdrawn']).optional().describe('resolve: how the flag was settled'),
        until: z.string().optional().describe('defer: ISO-8601 instant after which the subject is due again'),
        requestId: z.string().optional().describe('raise: id of the request (default derived); ask: the person\'s own question this prompt answers (the digest then drops it); note: the hand-over request a summary serves'),
        supersedes: z.string().optional().describe('ask: the promptId this better question replaces (a reshaped question; the old one closes)'),
        revisedQuestion: z.string().optional().describe('reshape: the better wording of the question'),
        passId: z.string().optional().describe('pass: id of the pass record (default pass-<stamp>)'),
        consumedUntil: z.string().optional().describe('pass: the digest\'s `until`; every answer and mark up to it counts as read'),
        scope: z.string().optional().describe('pass: level, persona or net the pass was limited to'),
        summary: z.string().optional().describe('pass: what the pass did, in two or three sentences'),
        answers: z.number().int().optional().describe('pass: how many answers it consumed'),
        changes: z.array(z.string()).optional().describe('pass: definitions revised, nets created, flags resolved, spec rebuilt'),
        questions: z.array(z.string()).optional().describe('pass: promptIds raised for the next focus session'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'curate_model', mutates: true }, async (model, args) => {
     try {
      return await curate(model, args);
     } catch (err: any) {
      const missing = applicationMissing(err, model);
      if (missing) return missing;
      throw err;
     }
    }),
  );

  async function curate(model: string, args: any): Promise<any> {
      const by = args.by ?? args.respondedBy ?? 'the person';
      const need = (field: string, value: unknown) => {
        if (value === undefined || value === null || value === '') throw new Error(`curate_model ${args.action} needs ${field}`);
      };
      const confirm = async (subjectKey: string) => {
        const input: Record<string, unknown> = {
          markId: args.markId ?? `confirm-${slug(subjectKey)}-${stamp()}`, subjectKind: curationSubjectKind(subjectKey), subjectKey, by,
          ...(args.subjectRevision != null ? { revision: args.subjectRevision } : {}),
          ...(args.notes ? { note: args.notes } : {}),
          ...(args.sourceHash ? { sourceHash: args.sourceHash } : {}),
        };
        const result = await act(model, 'curation', 'confirm', input, `curate-confirm-${input['markId']}`);
        return { markId: input['markId'], result };
      };
      const flag = async (subjectKey: string) => {
        need('flag', args.flag); need('reason', args.reason);
        const input: Record<string, unknown> = {
          markId: args.markId ?? `flag-${args.flag}-${slug(subjectKey)}-${stamp()}`, subjectKind: curationSubjectKind(subjectKey), subjectKey,
          flag: args.flag, reason: args.reason, by,
          ...(args.subjectRevision != null ? { revision: args.subjectRevision } : {}),
          ...(args.evidence ? { evidence: args.evidence } : {}),
        };
        const result = await act(model, 'curation', 'flag', input, `curate-flag-${input['markId']}`);
        return { markId: input['markId'], result };
      };
      switch (args.action) {
        case 'ask': {
          need('subjectKey', args.subjectKey); need('question', args.question);
          const subjectKey = args.subjectKey!;
          const promptId = args.promptId ?? `q-${slug(subjectKey)}-${stamp()}`;
          const input: Record<string, unknown> = {
            promptId, question: args.question, subjectKind: interviewSubjectKind(subjectKey), subjectKey,
            source: 'question-round',
            ...(args.header ? { header: args.header } : {}),
            ...(args.context ? { context: args.context } : {}),
            ...(args.reasoning ? { reasoning: args.reasoning } : {}),
            ...(args.evidence ? { evidence: args.evidence } : {}),
            ...(args.options ? { options: args.options } : {}),
            ...(args.multiSelect != null ? { multiSelect: args.multiSelect } : {}),
            ...(args.allowFreeText != null ? { allowFreeText: args.allowFreeText } : {}),
            ...(args.subjectRevision != null ? { subjectRevision: args.subjectRevision } : {}),
            ...(args.requestId ? { requestId: args.requestId } : {}),
            ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          };
          const result = await act(model, 'interview', 'ask', input, `curate-ask-${promptId}`);
          return { model, promptId, subjectKey, asked: input, result, answerWith: { action: 'answer', promptId, subjectKey } };
        }
        case 'answer': {
          need('promptId', args.promptId);
          if (!args.selected?.length && !args.text) throw new Error('curate_model answer needs selected or text');
          const input: Record<string, unknown> = {
            promptId: args.promptId, intent: 'answer', respondedBy: by,
            ...(args.selected ? { selected: args.selected } : {}),
            ...(args.text ? { text: args.text } : {}),
            ...(args.notes ? { notes: args.notes } : {}),
          };
          const result = await act(model, 'interview', 'respond', input, `curate-answer-${args.promptId}`);
          const out: Record<string, unknown> = { model, promptId: args.promptId, answered: input, result };
          if (args.then) {
            need('subjectKey', args.subjectKey);
            out[args.then === 'confirm' ? 'confirmed' : 'flagged'] = args.then === 'confirm' ? await confirm(args.subjectKey!) : await flag(args.subjectKey!);
          }
          return out;
        }
        case 'confirm': {
          need('subjectKey', args.subjectKey);
          return { model, subjectKey: args.subjectKey, ...(await confirm(args.subjectKey!)) };
        }
        case 'flag': {
          need('subjectKey', args.subjectKey);
          return { model, subjectKey: args.subjectKey, ...(await flag(args.subjectKey!)) };
        }
        case 'resolve': {
          need('markId', args.markId); need('how', args.how);
          const input: Record<string, unknown> = { markId: args.markId, how: args.how, by, ...(args.notes ? { note: args.notes } : {}) };
          const result = await act(model, 'curation', 'resolve', input, `curate-resolve-${args.markId}-${args.how}`);
          return { model, markId: args.markId, how: args.how, result };
        }
        case 'defer': {
          need('subjectKey', args.subjectKey); need('until', args.until);
          const subjectKey = args.subjectKey!;
          const input: Record<string, unknown> = {
            markId: args.markId ?? `defer-${slug(subjectKey)}-${stamp()}`, subjectKind: curationSubjectKind(subjectKey), subjectKey,
            until: args.until, by, ...(args.notes ? { note: args.notes } : {}),
          };
          const result = await act(model, 'curation', 'defer', input, `curate-defer-${input['markId']}`);
          return { model, subjectKey, until: args.until, markId: input['markId'], result };
        }
        case 'raise': {
          need('question', args.question);
          const subjectKey = args.subjectKey;
          const requestId = args.requestId ?? `r-${subjectKey ? slug(subjectKey) + '-' : ''}${stamp()}`;
          const input: Record<string, unknown> = {
            requestId, question: args.question, raisedBy: by,
            ...(args.context ? { context: args.context } : {}),
            ...(subjectKey ? { subjectKind: interviewSubjectKind(subjectKey), subjectKey } : {}),
          };
          const result = await act(model, 'interview', 'raise', input, `curate-raise-${requestId}`);
          return { model, requestId, subjectKey, result, next: 'The next refinement pass answers it (focus_digest lists it under ownQuestions) by asking back with a prompt that carries this requestId, or by changing the model.' };
        }
        case 'reshape': {
          need('promptId', args.promptId); need('revisedQuestion', args.revisedQuestion);
          const input: Record<string, unknown> = { promptId: args.promptId, intent: 'revise', revisedQuestion: args.revisedQuestion, respondedBy: by };
          const result = await act(model, 'interview', 'respond', input, `curate-reshape-${args.promptId}`);
          return { model, promptId: args.promptId, revisedQuestion: args.revisedQuestion, result, next: 'The next pass asks the reshaped question (ask with supersedes = this promptId).' };
        }
        case 'pass': {
          need('consumedUntil', args.consumedUntil);
          const passId = args.passId ?? `pass-${stamp()}`;
          const input: Record<string, unknown> = {
            passId, kind: 'refinement-pass', by, consumedUntil: args.consumedUntil, startedAt: new Date().toISOString(),
            ...(args.scope ? { scope: args.scope } : {}),
            ...(args.summary ? { summary: args.summary } : {}),
            ...(args.answers != null ? { answers: args.answers } : {}),
            ...(args.changes ? { changes: args.changes } : {}),
            ...(args.questions ? { questions: args.questions } : {}),
          };
          const result = await act(model, 'curation', 'pass', input, `curate-pass-${passId}`);
          return { model, passId, consumedUntil: args.consumedUntil, result, next: 'The next focus_digest starts after this pass; the person continues in the Explorer\'s Refine view.' };
        }
        case 'note': {
          need('subjectKey', args.subjectKey); need('text', args.text);
          const subjectKey = String(args.subjectKey);
          const noteKind = args.noteKind ?? (by === 'the person' ? 'brief' : 'summary');
          const noteId = args.noteId ?? `note-${noteKind}-${slug(subjectKey)}-${stamp()}`;
          const input: Record<string, unknown> = {
            noteId, noteKind, subjectKind: curationSubjectKind(subjectKey), subjectKey, text: args.text, by,
            ...(args.passId ? { passId: args.passId } : {}),
            ...(args.requestId ? { requestId: args.requestId } : {}),
          };
          const result = await act(model, 'curation', 'note', input, `curate-note-${noteId}`);
          return { model, noteId, noteKind, subjectKey, result,
            next: noteKind === 'brief'
              ? 'The next refinement pass derives the definition from it and answers with a summary note; hand_over runs that pass in the model.'
              : 'The person reads it in the thread of the subject (the Refine view) and on the card.' };
        }
        default:
          throw new Error(`unknown action ${String(args.action)}`);
      }
  }

  server.registerTool(
    'hand_over',
    {
      title: 'Hand the refinement work over to the AI: the pass lane or the read-only runner',
      description:
        'The person\'s "now it is your turn". kind refinement applies what the person answered and described, writes a summary per subject and prepares the next questions; it runs on the coder below once a sources folder is configured, otherwise on the refinement\'s agent lane (t-refinement-pass) inside the model through this MCP server (runner forces one). '
        + 'The other kinds need the sources and run a headless coder READ-ONLY in the folder of the model\'s sources on the executor (code, documents, data), on the refinement\'s runner lanes through the headless-agent runner (a read-only runner profile, Claude Code by default), with this MCP server attached so everything it finds lands in the model: structure (settle the AI\'s structural cards from the sources), ground (check the levels of the scope or model against the sources), and on one subject: look (the person\'s own instruction in note), explain (a finding note: what it really does according to the sources), check (confirm, correct drift, or ask), draft (a draft definition for what is missing), diff (a finding note listing the card\'s claims against the sources). '
        + 'Coder kinds need a sources root first (refinement_configure); without it the answer is state needs-setup. The refinement and its runner install themselves into the model on the first hand-over. Optional scope (domain:<d>, tag:<t>, net:<session::net>), subject (session::net, session::net#element, scope:<expr>@<level>), note, card (the card the person is on). dryRun reports what would run, for a coder kind with the full prompt, and writes nothing. '
        + 'Use it when the person wants the work done in the background; run the pass yourself when you ARE the AI they are talking to.',
      inputSchema: {
        kind: z.enum(['refinement', 'structure', 'ground', 'look', 'explain', 'check', 'draft', 'diff']).default('refinement'),
        scope: z.string().optional().describe('A focus scope: domain:<d>, tag:<t>, net:<session::net>'),
        subject: z.string().optional().describe('The subject: required for look, explain, check, draft, diff (session::net, session::net#element, scope:<expr>@<level>)'),
        note: z.string().optional().describe('What the person wants, in their words (required for look)'),
        runner: z.enum(['agent', 'coder']).optional().describe('refinement only: agent = the pass lane with the master\'s LLM, coder = the headless runner (default when a sources folder is configured)'),
        card: z.record(z.unknown()).optional().describe('The card the person is on: {kind, detail, question}; it goes into the coder\'s prompt'),
        by: z.string().optional().describe('Who hands over (default "the person")'),
        dryRun: z.boolean().optional().describe('Report what would run; write nothing'),
        requestId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional().describe('Retry the same request (after a 502 not-fired) instead of writing a second one'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'hand_over', mutates: true }, async (model, args) => {
      const body = { kind: args.kind ?? 'refinement', scope: args.scope, subject: args.subject, note: args.note, card: args.card, runner: args.runner, by: args.by ?? 'the person', dryRun: !!args.dryRun,
        ...(args.requestId ? { requestId: args.requestId } : {}) };
      const post = () => refinementCall(ctx, 'POST', model, '/run', body);
      let result: any;
      try {
        result = await post();
      } catch (err: any) {
        { const missing = missingAnswer(err, model, '/api/explorer/{model}/refinement/run'); if (missing) return missing; }
        if (err?.status !== 409) throw err;
        result = conflictBody(err);
      }
      if (result?.state === 'needs-setup' && Array.isArray(result?.applications) && result.applications.length) {
        // An older master: the review method's applications, installed on purpose.
        const names = result.applications.map((a: any) => `hub_install {name:"${a.name}", version:"latest", model:"${model}"}`).join(', ');
        return { ...result, next: `Install what is missing from the local hub (seeded): ${names}; then hand over again.` };
      }
      if (result?.state === 'needs-setup' && Array.isArray(result?.missing) && result.missing.includes('mcp-url')) {
        return { ...result, next: 'The master does not know its own MCP server (agenticos.mcp.self.url; the Desktop launcher sets it). '
          + 'Nothing to configure in the model: set it on the master, restart it, then hand over again.' };
      }
      if (result?.state === 'needs-setup' && result?.mcp === 'unavailable') {
        return { ...result, next: 'The MCP server the refinement would use is not reachable from the master; a grant cannot help. Start it (or fix agenticos.mcp.self.url), then hand over again.' };
      }
      if (result?.state === 'needs-setup' && Array.isArray(result?.missing) && result.missing.includes('mcp-grant')) {
        // The refinement asks for MCP access in its package; only the person grants it (this server attaches nothing itself).
        const tools = Array.isArray(result?.mcpRequested?.allowTools) ? result.mcpRequested.allowTools.length : undefined;
        return { ...result, next: `The refinement asks for MCP access${tools ? ` (${tools} review tools on its pass and run lanes)` : ''}. `
          + `Grant it only when the person agrees: refinement_access {action:"grant", model:"${model}"} (or the Refine view's setup); then hand over again.` };
      }
      if (result?.state === 'needs-setup' && result?.runner === 'coder' && Array.isArray(result?.missing) && result.missing.includes('headless-agent')) {
        return { ...result, next: `The runner is missing and could not be installed: hub_install {name:"headless-agent", version:"latest", model:"${model}"} (seeded); then hand over again.` };
      }
      if (result?.state === 'needs-setup' && result?.runner === 'coder' && (!Array.isArray(result?.missing) || result.missing.includes('root'))) {
        return { ...result, next: `Tell the runner where the sources are: refinement_configure {root, profile, model:"${model}"}, then hand over again.` };
      }
      if (result?.state === 'needs-setup') {
        return { ...result, next: `Not ready: ${(result?.missing ?? []).join(', ') || 'see hint'}. ${String(result?.hint ?? '')}`.trim() };
      }
      return { ...result, next: result?.state === 'running'
        ? (result?.runner === 'coder'
          ? 'The runner reads the sources (minutes); refinement_status lists the run with its report when it is done, and subject_thread shows its notes and questions.'
          : 'The lane runs the pass; refinement_status shows when its run is recorded, then the Refine view and focus_digest carry the summaries and the next questions.')
        : result?.state === 'would-run' ? 'Call again without dryRun to run it.' : String(result?.hint ?? '') };
    }),
  );

  for (const name of ['refinement_configure', 'refiner_configure']) server.registerTool(
    name,
    {
      title: name === 'refiner_configure' ? 'Old name of refinement_configure' : 'Set up the runner of the hand-over: where the sources are and which profile reads them',
      description: 'Where the read-only runner of hand_over and of the question rounds works on this model: root = the folder of the model\'s sources on the executor (~ allowed), profile = a read-only runner profile (default claude-code-read-only; refinement_status lists them as coders; a write profile is refused), model = the runner\'s model (optional). Appends a settings record (the newest wins) with a snapshot of the profile. Read the current setting with refinement_status (config).',
      inputSchema: {
        root: z.string().min(1).describe('The folder of the sources on the executor, e.g. ~/Documents/handbook or ~/Developer/my-app'),
        profile: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional().describe('A read-only runner profile (default claude-code-read-only)'),
        coder: z.enum(['claude', 'codex']).optional().describe('Older settings: claude or codex (mapped to the read-only profiles); use profile'),
        coderModel: z.string().optional().describe('The runner\'s model id (optional)'),
        by: z.string().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name, mutates: true }, async (model, args) => {
      const profileId = args.profile ?? (args.coder === 'codex' ? 'codex-read-only' : args.coder ? 'claude-code-read-only' : undefined);
      const body = { root: args.root, profileId, model: args.coderModel, by: args.by ?? 'the person' };
      try {
        const saved = await refinementCall(ctx, 'POST', model, '/run/config', body);
        return { model, config: saved, next: 'hand_over with a runner kind (explain, look, check, draft, diff, ground, structure) and focus_round now run in this root.' };
      } catch (err: any) {
        if (err?.status === 409) {
          const c = conflictBody(err);
          return { available: false, model, reason: 'needs-install', hint: String(c.error ?? c.hint ?? err?.message ?? 'not ready'),
            next: `An older master runs the refinement as the Focus application: hub_install {name:"refiner", version:"latest", model:"${model}"}, then configure again.` };
        }
        { const missing = missingAnswer(err, model, '/api/explorer/{model}/refinement/run/config'); if (missing) return missing; }
        throw err;
      }
    }),
  );

  server.registerTool(
    'refinement_access',
    {
      title: 'The refinement\'s MCP access: read, grant or revoke',
      description: 'The refinement\'s lanes (the pass lane and the runner\'s run lanes) reach this model through this MCP server only with the person\'s grant. action state (default) reads what it asks for and whether it is granted; grant gives it (only when the person agrees: it stores this server\'s token on those lanes under the listed tool allowlist); revoke takes it back. A grant installs the refinement into the model first.',
      inputSchema: { action: z.enum(['state', 'grant', 'revoke']).default('state'), by: z.string().optional(), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'refinement_access', mutates: true }, async (model, args) => {
      const action = args.action ?? 'state';
      const m = encodeURIComponent(model);
      try {
        if (action === 'grant') return await ctx.client.masterApi('POST', `/explorer/${m}/refinement/access`, { by: args.by ?? 'the person' }, { modelId: model });
        if (action === 'revoke') return await ctx.client.masterApi('DELETE', `/explorer/${m}/refinement/access`, undefined, { modelId: model });
        return await ctx.client.masterApi('GET', `/explorer/${m}/refinement/access`, undefined, { modelId: model });
      } catch (err: any) {
        if (routeMissing(err)) {
          return { available: false, model, reason: 'route-missing',
            hint: `This master runs the refinement as the Focus application: application_mcp {name:"refiner", action:"${action}", model:"${model}"}` };
        }
        throw err;
      }
    }),
  );

}

/**
 * The ground's chains share their upper nets (every bottom net climbs to the same product net): on a live model
 * 101 nodes were 56 nets and the read was 229 KB. A net listed in an earlier chain repeats only what tells the
 * chains apart (key, title, level, confirmed) and where its claims are (sameAs: "chains[i]").
 */
export function compactChains(served: any): any {
  if (!served || !Array.isArray(served.chains)) return served;
  const first = new Map<string, number>();
  const chains = served.chains.map((chain: any, i: number) => ({
    ...chain,
    nodes: (Array.isArray(chain?.nodes) ? chain.nodes : []).map((node: any) => {
      const key = String(node?.key ?? '');
      if (!key) return node;
      if (!first.has(key)) { first.set(key, i); return node; }
      return { key, title: node.title, level: node.level, confirmed: node.confirmed ?? null, sameAs: `chains[${first.get(key)}]` };
    }),
  }));
  return { ...served, chains, compact: true };
}

/** A 409 from the master carries the hand-over state as JSON text in the GatewayError body. */
function conflictBody(err: any): Record<string, any> {
  const raw = err?.body;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { /* not JSON */ } }
  return { state: 'needs-setup', error: String(err?.message ?? '') };
}


