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

const FLAGS = ['stale', 'unclear', 'wrong', 'contradiction', 'unmeasured', 'too-coarse', 'level-below-changed', 'level-above-changed'] as const;

function cataloguePath(model: string): string {
  const m = encodeURIComponent(model);
  return `/explorer/${m}/catalogue?modelId=${m}`;
}

function curationPath(model: string): string {
  const m = encodeURIComponent(model);
  return `/explorer/${m}/curation?modelId=${m}`;
}

/** Interview subject kind for a subject key: a net, one of its elements, or a level. */
export function interviewSubjectKind(subjectKey: string): 'net-definition' | 'net-element' | 'level' {
  if (subjectKey.includes('#')) return 'net-element';
  if (subjectKey.includes('::')) return 'net-definition';
  return 'level';
}

/** Curation subject kind for a subject key. */
export function curationSubjectKind(subjectKey: string): 'net' | 'element' | 'level' | 'relation' {
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
export function refineWorklist(catalogue: any, review: any, opts: { level?: string; net?: string; direction?: 'down' | 'up' | 'both'; count?: number } = {}): any {
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
        + 'Scope with level (a level id) or net (session::netId); direction down | up | both; count caps the list. Read-only.',
      inputSchema: {
        level: z.string().optional().describe('Only nets on this level'),
        net: z.string().optional().describe('Only this net (session::netId)'),
        direction: z.enum(['down', 'up', 'both']).default('both'),
        count: z.number().int().positive().max(200).optional().describe('At most this many items (default: all)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'refine_model', mutates: false }, async (model, args) => {
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
      return refineWorklist(catalogue, review, { level: args.level, net: args.net, direction: args.direction, count: args.count });
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
        + 'ask: a question to the person about a subject (session::net, session::net#elementId, or a level id); options optional; the subject fields are derived from the key. '
        + 'answer: record what the person said (selected and/or text) on a promptId; with then:"confirm" the subject is confirmed in the same call (by = the person), with then:"flag" it is flagged (flag + reason). '
        + 'confirm / flag / resolve: write a mark directly (markId defaults to a deterministic id). Nothing here starts anything.',
      inputSchema: {
        action: z.enum(['ask', 'answer', 'confirm', 'flag', 'resolve']),
        subjectKey: z.string().optional().describe('ask, confirm, flag, and answer with then: the subject'),
        question: z.string().optional().describe('ask: the question, in the person\'s words'),
        header: z.string().optional().describe('ask: short chip label'),
        context: z.string().optional().describe('ask: what was measured or read'),
        options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string(), description: z.string().optional(), recommended: z.boolean().optional() })])).optional(),
        multiSelect: z.boolean().optional(),
        allowFreeText: z.boolean().optional(),
        promptId: z.string().optional().describe('ask: id of the new prompt (default derived); answer: the prompt answered'),
        subjectRevision: z.number().int().optional().describe('ask/confirm: definition revision the question or confirmation is against'),
        selected: z.array(z.string()).optional().describe('answer: chosen option values'),
        text: z.string().optional().describe('answer: free text'),
        notes: z.string().optional().describe('answer: a note beside the choice; confirm: why it is right'),
        respondedBy: z.string().optional().describe('answer: who answered (default "the person")'),
        then: z.enum(['confirm', 'flag']).optional().describe('answer: also confirm or flag subjectKey'),
        by: z.string().optional().describe('confirm/flag/resolve: who (default "the person")'),
        flag: z.enum(FLAGS).optional().describe('flag, or answer with then:"flag"'),
        reason: z.string().optional().describe('flag: what was measured or read'),
        evidence: z.array(z.string()).optional().describe('flag: files, lines, numbers, the person\'s words'),
        sourceHash: z.string().optional().describe('confirm: hash of the referenced sources at this moment'),
        markId: z.string().optional().describe('confirm/flag: id of the new mark (default deterministic); resolve: the flag'),
        how: z.enum(['changed', 'confirmed', 'withdrawn']).optional().describe('resolve: how the flag was settled'),
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
        default:
          throw new Error(`unknown action ${String(args.action)}`);
      }
    }),
  );
}
