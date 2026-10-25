/**
 * Top-down and bottom-up refinement of a model's abstraction hierarchy, as tools an MCP client
 * drives by itself (no server-side LLM needed, no prompt required):
 *
 * - `refine_model` (read-only): the worklist of a level or a net. Looking down: transitions nothing
 *   refines yet, refinements that do not verify, definitions still draft or ready. Looking up: nets
 *   with neither a parent nor an `explains` relation. Plus the review: open flags, open questions,
 *   subjects nobody confirmed. Every item carries a ready-made Interview `ask` input, so the client
 *   can turn a gap into a question for the person in one call.
 * - `curate_model` (writes): ask, answer, confirm, flag, resolve, each a thin, validated wrapper over
 *   the Interview and Curation application actions with deterministic ids.
 *
 * Everything is designtime: nothing here starts a lane or spends quota.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { assignInscription, withMcpFlag } from '../inscriptions.js';
import { SELF_CREDENTIAL_KEY, SELF_SERVER_NAME, describeSelf } from './mcp-servers.js';

const FLAGS = ['stale', 'unclear', 'wrong', 'contradiction', 'unmeasured', 'too-coarse', 'level-below-changed', 'level-above-changed'] as const;

function cataloguePath(model: string): string {
  const m = encodeURIComponent(model);
  return `/explorer/${m}/catalogue?modelId=${m}`;
}

function curationPath(model: string): string {
  const m = encodeURIComponent(model);
  return `/explorer/${m}/curation?modelId=${m}`;
}

function worklistPath(model: string, args: { level?: string; net?: string; direction?: string; mode?: string; count?: number; for?: string; scope?: string; ring?: string }): string {
  const m = encodeURIComponent(model);
  const q = new URLSearchParams({ modelId: model });
  if (args.level) q.set('level', args.level);
  if (args.net) q.set('net', args.net);
  if (args.direction) q.set('direction', args.direction);
  if (args.mode) q.set('mode', args.mode);
  if (args.count) q.set('count', String(args.count));
  if (args.for) q.set('for', args.for);
  if (args.scope) q.set('scope', args.scope);
  if (args.ring) q.set('ring', args.ring);
  return `/explorer/${m}/worklist?${q.toString()}`;
}

function groundPath(model: string, args: { level?: string; net?: string; scope?: string }): string {
  const m = encodeURIComponent(model);
  const q = new URLSearchParams({ modelId: model });
  if (args.level) q.set('level', args.level);
  if (args.net) q.set('net', args.net);
  if (args.scope) q.set('scope', args.scope);
  return `/explorer/${m}/ground?${q.toString()}`;
}

const GROUND_NEXT = 'For each chain (prompt ground-model): read the bottom node\'s references from the sources, then check every node above against them, bottom-up. Agree: curate_model {action:"confirm", sourceHash}. A mechanical divergence (a name, a value, a count): update_net_definition or the specification, then confirm. A divergence that is a decision: curate_model {action:"flag", flag:"contradiction", evidence} on the node and {action:"ask"} with evidence, reasoning and options [keep the level as written | adopt what the sources do | both need a change]. Record the pass with scope "ground:<level>".';

function digestPath(model: string, args: { since?: string; level?: string; scope?: string; ring?: string }): string {
  const m = encodeURIComponent(model);
  const q = new URLSearchParams({ modelId: model });
  if (args.since) q.set('since', args.since);
  if (args.level) q.set('level', args.level);
  if (args.scope) q.set('scope', args.scope);
  if (args.ring) q.set('ring', args.ring);
  return `/explorer/${m}/digest?${q.toString()}`;
}

const DIGEST_NEXT = 'Apply it top-down (prompt refinement-pass): revise the definitions the answers touch, create the child definitions the person asked for, resolve settled flags, rebuild from the specification when the model is spec-built, raise the next questions with curate_model {action:"ask"}, then record the pass with curate_model {action:"pass", consumedUntil: this digest\'s `until`}.';

export function handoverPath(model: string): string {
  const m = encodeURIComponent(model);
  return `/explorer/${m}/handover?modelId=${m}`;
}

export function threadPath(model: string, subject: string): string {
  const m = encodeURIComponent(model);
  const q = new URLSearchParams({ modelId: model, subject });
  return `/explorer/${m}/thread?${q.toString()}`;
}

export function scopePath(model: string, scope: string): string {
  const m = encodeURIComponent(model);
  const q = new URLSearchParams({ modelId: model, scope });
  return `/explorer/${m}/scope?${q.toString()}`;
}

const SCOPE_NEXT = 'Work inside the scope: refine_model {scope} for its cards (ring:"all" adds the open decisions of the nets around it), focus_digest {scope} for what the person answered about it, ground_model {scope} for its chains. Look around before asking: each open gap (a level the scope\'s chain passes without a net of its own) is settled by a definition on that level (create_net_definition), or by curate_model {action:"confirm", subjectKey: the gap\'s subjectKey, notes: "covered by <net>" or "not needed: <why>"}; compare with the examples on that level (what other features have there) and with the neighbours (relations, shared places) for what the scope may be missing, and ask the person only what the sources cannot settle. Record the pass with scope = passScope.';

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
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'refine_model', mutates: false }, async (model, args) => {
      // The master computes the one worklist the Explorer's Focus view and the scripts read too
      // (it also honours deferred subjects); an older master without the route gets the local fold.
      try {
        const served = await ctx.master.get(worklistPath(model, args));
        if (served && Array.isArray(served.items)) {
          return { ...served, next: WORKLIST_NEXT };
        }
      } catch (err: any) {
        if (err?.status !== 404) throw err;
      }
      if (args.scope) {
        return { available: false, model, hint: 'master without focus scopes: upgrade master (refine_model without scope still works)' };
      }
      let catalogue: any;
      let review: any;
      try {
        [catalogue, review] = await Promise.all([ctx.master.get(cataloguePath(model)), ctx.master.get(curationPath(model))]);
      } catch (err: any) {
        if (err?.status === 404) {
          return { available: false, model, hint: 'master without /api/explorer: upgrade master' };
        }
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
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'ground_model', mutates: false }, async (model, args) => {
      try {
        const served = await ctx.master.get(groundPath(model, args));
        return { ...served, next: GROUND_NEXT };
      } catch (err: any) {
        if (err?.status === 404) {
          return { available: false, model, hint: 'master without /api/explorer/{model}/ground: upgrade master' };
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    'focus_digest',
    {
      title: 'What the person answered since the last refinement pass',
      description:
        'The digest of a model: every answer, confirmation, flag, resolution and deferral the person recorded (in the Explorer\'s Focus view, the Interview inbox or by curate_model) since the last refinement pass, grouped by level and subject, plus the questions still open. '
        + 'Focus sessions and refinement passes alternate as often as needed: the digest starts after the newest `pass` record (curate_model {action:"pass"}) unless `since` is given. Read-only; `until` is the instant to hand back as consumedUntil when the pass is recorded.',
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
        const served = await ctx.master.get(digestPath(model, args));
        return { ...served, next: DIGEST_NEXT };
      } catch (err: any) {
        if (err?.status === 404) {
          return { available: false, model, hint: 'master without /api/explorer/{model}/digest: upgrade master' };
        }
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
        return { ...served, next: SCOPE_NEXT };
      } catch (err: any) {
        if (err?.status === 404) {
          return { available: false, model, error: String(err?.message ?? ''), hint: 'an unknown model, or a master without /api/explorer/{model}/scope (upgrade master)' };
        }
        throw err;
      }
    }),
  );
  server.registerTool(
    'refiner_status',
    {
      title: 'The Refiner lane: installed, attached, running, pending requests and the last runs',
      description: 'Read-only state of the hand-over lane on the model: whether the Refiner application is installed, whether the lane carries an MCP server, which LLM it thinks with, whether a pass is running now, the pending requests and the last runs with their reports.',
      inputSchema: { ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'refiner_status', mutates: false }, async (model) => {
      try {
        return await ctx.master.get(handoverPath(model));
      } catch (err: any) {
        if (err?.status === 404) return { available: false, model, hint: 'master without /api/explorer/{model}/handover: upgrade master' };
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
        return await ctx.master.get(threadPath(model, args.subject));
      } catch (err: any) {
        if (err?.status === 404) return { available: false, model, hint: 'master without /api/explorer/{model}/thread: upgrade master' };
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

  const act = (model: string, application: string, action: string, input: Record<string, unknown>, idempotencyKey?: string) =>
    ctx.client.masterApi('POST',
      `/applications/${encodeURIComponent(model)}/${encodeURIComponent(application)}/actions/${encodeURIComponent(action)}`,
      input, idempotencyKey ? { idempotencyKey } : undefined);

  server.registerTool(
    'curate_model',
    {
      title: 'Ask, answer, confirm, flag or resolve on a model subject',
      description:
        'Writes of a question round, each a validated wrapper over the Interview and Curation applications with deterministic ids. '
        + 'ask: a question to the person about a subject (session::net, session::net#elementId, or a level id); the subject fields are derived from the key. A card needs substance: evidence (what was read or measured), reasoning (the argument and the recommendation) and options with a description each, one recommended. '
        + 'answer: record what the person said (selected and/or text) on a promptId; with then:"confirm" the subject is confirmed in the same call (by = the person), with then:"flag" it is flagged (flag + reason). '
        + 'confirm / flag / resolve / defer (until a date): write a mark directly (markId defaults to a deterministic id). '
        + 'pass: record a refinement pass (consumedUntil = the digest\'s `until`, summary, changes, questions raised), so the next focus_digest starts after it. '
        + 'raise: the person\'s own question about a subject (an Interview request; the digest lists it until a prompt carries its requestId). reshape: the person reshapes a question (respond with intent revise and the better wording; the next pass asks again). '
        + 'note: words about a subject (Curation 1.3.0): noteKind brief = what the person said about it in their own words (the next pass derives the definition from it), summary = what the AI understood, changed and left open after a pass (the person reads it on the card), decision = settled for good, finding = what the sources say now, written by a coder that read them (Curation 1.4.0; explain, look and diff write one). Nothing here starts anything.',
      inputSchema: {
        action: z.enum(['ask', 'answer', 'confirm', 'flag', 'resolve', 'defer', 'pass', 'raise', 'reshape', 'note']),
        noteKind: z.enum(['brief', 'summary', 'decision', 'finding']).optional().describe('note: brief (the person\'s words), summary (the AI\'s, after a pass), decision, finding (what the sources say, with file:line)'),
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
        requestId: z.string().optional().describe('raise: id of the request (default derived); note: the hand-over request a summary serves'),
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
          return { model, passId, consumedUntil: args.consumedUntil, result, next: 'The next focus_digest starts after this pass; the person continues in the Focus view.' };
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
              : 'The person reads it in the thread of the subject (Focus view) and on the card.' };
        }
        default:
          throw new Error(`unknown action ${String(args.action)}`);
      }
    }),
  );

  server.registerTool(
    'hand_over',
    {
      title: 'Hand the focus work over to the AI: the agent lane or the read-only coder',
      description:
        'The person\'s "now it is your turn". kind refinement applies what the person answered and described, writes a summary per subject and prepares the next questions; it runs on the coder below once a sources folder is configured, otherwise on the Refiner application\'s agent lane (t-refiner-pass) inside the model through this MCP server (runner forces one). '
        + 'The other kinds need the sources and run a headless coder (Claude Code by default, Codex selectable) READ-ONLY in the folder of the model\'s sources on the executor (code, documents, data), through the reusable headless-coder tool net, with this MCP server attached so everything it finds lands in the model: structure (settle the AI\'s structural cards from the sources), ground (check the levels of the scope or model against the code), and on one subject: look (the person\'s own instruction in note), explain (a finding note: what it really does in the code), check (confirm, correct drift, or ask), draft (a draft definition for what is missing), diff (a finding note listing the card\'s claims against the code). '
        + 'Coder kinds need a sources root first (refiner_configure); without it the answer is state needs-setup. Optional scope (domain:<d>, tag:<t>, net:<session::net>), subject (session::net, session::net#element, scope:<expr>@<level>), note, card (the card the person is on). dryRun reports what would run, for a coder kind with the full prompt, and writes nothing. '
        + 'Use it when the person wants the work done in the background; run the pass yourself when you ARE the AI they are talking to.',
      inputSchema: {
        kind: z.enum(['refinement', 'structure', 'ground', 'look', 'explain', 'check', 'draft', 'diff']).default('refinement'),
        scope: z.string().optional().describe('A focus scope: domain:<d>, tag:<t>, net:<session::net>'),
        subject: z.string().optional().describe('The subject: required for look, explain, check, draft, diff (session::net, session::net#element, scope:<expr>@<level>)'),
        note: z.string().optional().describe('What the person wants, in their words (required for look)'),
        runner: z.enum(['agent', 'coder']).optional().describe('refinement only: agent = the Refiner lane with the master\'s LLM, coder = the headless coder (default when a sources folder is configured)'),
        card: z.record(z.unknown()).optional().describe('The card the person is on: {kind, detail, question}; it goes into the coder\'s prompt'),
        by: z.string().optional().describe('Who hands over (default "the person")'),
        dryRun: z.boolean().optional().describe('Report what would run; write nothing'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'hand_over', mutates: true }, async (model, args) => {
      const body = { kind: args.kind ?? 'refinement', scope: args.scope, subject: args.subject, note: args.note, card: args.card, runner: args.runner, by: args.by ?? 'the person', dryRun: !!args.dryRun };
      const post = () => ctx.client.masterApi('POST', `/explorer/${encodeURIComponent(model)}/handover`, body, { modelId: model });
      let result: any;
      try {
        result = await post();
      } catch (err: any) {
        if (err?.status === 404) return { available: false, model, hint: 'master without /api/explorer/{model}/handover: upgrade master' };
        if (err?.status !== 409) throw err;
        result = conflictBody(err);
      }
      if (result?.state === 'needs-setup' && result?.runner === 'coder') {
        return { ...result, next: 'Tell the coder where the sources are: refiner_configure {root, coder, model}, then hand over again.' };
      }
      if (result?.state === 'needs-setup' && !args.dryRun) {
        // The master could not attach its MCP server; this server attaches itself to the lane, then asks again.
        const attach = await attachSelfToLane(ctx, model, String(result.lane ?? 't-refiner-pass'));
        try {
          result = await post();
        } catch (err: any) {
          if (err?.status !== 409) throw err;
          result = conflictBody(err);
        }
        result = { ...result, attached: attach };
      }
      return { ...result, next: result?.state === 'running'
        ? (result?.runner === 'coder'
          ? 'The coder reads the sources (minutes); refiner_status lists the run with its report when it is done, and subject_thread shows its notes and questions.'
          : 'The lane runs the pass; refiner_status shows when its run is recorded, then the Focus view and focus_digest carry the summaries and the next questions.')
        : result?.state === 'would-run' ? 'Call again without dryRun to run it.' : String(result?.hint ?? '') };
    }),
  );

  server.registerTool(
    'refiner_configure',
    {
      title: 'Set up the coder of the hand-over: where the sources are and which coder reads them',
      description: 'Where the read-only coder of hand_over works on this model: root = the folder of the model\'s sources on the executor (~ allowed), coder = claude (Claude Code, default) or codex, model = the coder\'s model (optional). Appends a Refiner config token (the newest wins). Read the current setting with refiner_status (config).',
      inputSchema: {
        root: z.string().min(1).describe('The folder of the sources on the executor, e.g. ~/Documents/handbook or ~/Developer/my-app'),
        coder: z.enum(['claude', 'codex']).optional().describe('claude (default) or codex'),
        coderModel: z.string().optional().describe('The coder\'s model id (optional)'),
        by: z.string().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'refiner_configure', mutates: true }, async (model, args) => {
      const body = { root: args.root, coder: args.coder ?? 'claude', model: args.coderModel, by: args.by ?? 'the person' };
      try {
        const saved = await ctx.client.masterApi('POST', `/explorer/${encodeURIComponent(model)}/handover/config`, body, { modelId: model });
        return { model, config: saved, next: 'hand_over with a coder kind (explain, look, check, draft, diff, ground, structure) now runs in this root.' };
      } catch (err: any) {
        if (err?.status === 404) return { available: false, model, hint: 'master without /api/explorer/{model}/handover/config: upgrade master' };
        throw err;
      }
    }),
  );

}

/** A 409 from the master carries the hand-over state as JSON text in the GatewayError body. */
function conflictBody(err: any): Record<string, any> {
  const raw = err?.body;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { /* not JSON */ } }
  return { state: 'needs-setup', error: String(err?.message ?? '') };
}

/** What attach_mcp_server {self:true} does, for the hand-over lane: declaration, m flag, this server's token in the vault. */
async function attachSelfToLane(ctx: AppContext, model: string, transitionId: string): Promise<Record<string, unknown>> {
  const self = describeSelf(ctx);
  if (!self.attachable) return { attached: false, reason: self.reason };
  const current: any = await ctx.executorFor(model).execute('GET_TRANSITION', { transitionId });
  const inscription = current?.data?.inscription ?? current?.data;
  if (!inscription || typeof inscription !== 'object') return { attached: false, reason: `transition '${transitionId}' has no inscription in model '${model}'` };
  const action = { ...(inscription.action ?? {}) };
  const existing: any[] = Array.isArray(action.mcp) ? action.mcp.filter((s: any) => s?.name !== SELF_SERVER_NAME) : [];
  action.mcp = [...existing, { ...self.declaration }];
  action.role = withMcpFlag(action.role);
  const next = { ...inscription, action, ...(inscription.role !== undefined ? { role: action.role } : {}) };
  await ctx.master.stopTransition(transitionId, model).catch(() => undefined);
  await assignInscription(ctx, model, next, 'agentic-net-master');
  await ctx.client.masterApi('POST', `/transitions/${transitionId}/credentials`, { [SELF_CREDENTIAL_KEY]: ctx.config.httpToken }, { modelId: model });
  return { attached: true, server: SELF_SERVER_NAME, url: self.url };
}
