/**
 * Net definitions and their build protocol (Model Explorer, slice 2).
 *
 * A definition is a persistent workspace net that exists before its places and transitions: a
 * name, a natural-language description, how it interacts with other nets, where it sits in the
 * abstraction hierarchy, and a revision history. A build turns one revision into topology under a
 * fenced lease: claim, plan, ask, apply (stopped), verify, complete. Everything here is designtime
 * data behind master's /api/explorer routes; the engine is unchanged and nothing starts unless the
 * build policy says so.
 *
 * Readers are GET-only and registered in both modes; writers are rw only.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { StructuredToolError, wrapTool } from '../scope.js';
import { refinementCall } from './refinement-routes.js';

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'superseded']);
const ACTIVE_STATES = new Set(['claimed', 'planning', 'building', 'verifying']);
/** list_net_definitions detail:"full" reads one detail document per definition; keep it bounded. */
const FULL_DETAIL_CAP = 25;

/** `/explorer/<m><rest>` with `modelId=<m>` always appended (gateway routing needs it). */
export function explorerPath(model: string, rest: string): string {
  const m = encodeURIComponent(model);
  return `/explorer/${m}${rest}${rest.includes('?') ? '&' : '?'}modelId=${m}`;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Call master; a non-2xx carrying master's `{error, code}` becomes a structured tool error with
 * that code (lease-lost, superseded, cancel-requested, ...). Never reports success on a non-2xx.
 */
export async function masterCall(ctx: AppContext, method: string, path: string, body?: any): Promise<any> {
  try {
    return await ctx.client.masterApi(method, path, body);
  } catch (err: any) {
    if (err?.name === 'GatewayError') {
      const raw = String(err.body ?? '').trim();
      let parsed: any = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && (parsed.code || parsed.error)) {
        const { code, error, ...rest } = parsed;
        throw new StructuredToolError({
          code: code ?? `HTTP_${err.status}`,
          status: err.status,
          error: error ?? raw.slice(0, 500),
          ...(err.path ? { attempted: String(err.path) } : {}),
          ...rest,
        });
      }
    }
    throw err;
  }
}

/**
 * Claimable definition work for readiness, from the catalogue's definitions: `ready` (status ready,
 * no open build), `queued`, `awaitingAnswers`, `building` (claimed/planning/building/verifying).
 */
export function definitionReadiness(catalogue: any): any {
  const defs: any[] = Array.isArray(catalogue?.definitions) ? catalogue.definitions : [];
  let ready = 0;
  let queued = 0;
  let awaitingAnswers = 0;
  let building = 0;
  for (const d of defs) {
    const latest = typeof d?.latestBuildState === 'string' ? d.latestBuildState : null;
    const open = typeof d?.activeBuild === 'string' && d.activeBuild !== '';
    if (open && latest === 'queued') queued++;
    else if (open && latest === 'awaiting-answers') awaitingAnswers++;
    else if (open && latest && ACTIVE_STATES.has(latest)) building++;
    else if (!open && d?.status === 'ready') ready++;
  }
  const out: any = { available: true, definitions: defs.length, ready, queued, awaitingAnswers, building };
  if (ready + queued + awaitingAnswers > 0) {
    out.hint = `${ready + queued} definition build(s) can be claimed and ${awaitingAnswers} wait for answers: `
      + 'use the realize-net-definition prompt (list_net_definitions, then get_net_definition for next actions)';
  }
  return out;
}

/** layer, domain, responsible, tags as given (undefined fields are left out). */
export function organizationFields(args: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of ['layer', 'domain', 'responsible'] as const) {
    if (typeof args?.[k] === 'string') out[k] = args[k];
  }
  if (Array.isArray(args?.tags)) out.tags = args.tags;
  return out;
}

function buildIdOf(b: any): string | undefined {
  return b?.buildId ?? b?.request?.buildId ?? b?.id;
}

function stateOf(b: any): string | undefined {
  return b?.state ?? b?.attempt?.state;
}

function attemptOf(b: any): any {
  return b?.attempt ?? b ?? {};
}

/** Compact build row for answers: never the full plan or log. */
export function buildSummary(b: any): any {
  const a = attemptOf(b);
  return {
    buildId: buildIdOf(b),
    state: stateOf(b),
    revision: b?.revision ?? b?.request?.revision ?? a?.revision,
    owner: a?.owner ?? null,
    leaseGeneration: a?.leaseGeneration ?? null,
    leaseExpiresAt: a?.leaseExpiresAt ?? null,
    cancelRequested: a?.cancelRequested === true,
    updatedAt: a?.updatedAt ?? b?.updatedAt ?? null,
  };
}

function leaseExpired(summary: any, now: number): boolean {
  if (!summary?.leaseExpiresAt) return true;
  const t = Date.parse(String(summary.leaseExpiresAt));
  return Number.isFinite(t) ? t <= now : true;
}

function openQuestions(detail: any): any[] {
  const open = detail?.questions?.open;
  return Array.isArray(open) ? open : [];
}

/** Derive what a client should do next from the definition detail document. */
export function nextActions(detail: any, now: number = Date.now()): string[] {
  const def = detail?.definition;
  const sessionId = detail?.net?.ref?.sessionId ?? def?.ref?.sessionId;
  const netId = detail?.net?.ref?.netId ?? def?.ref?.netId;
  const where = sessionId && netId ? ` {sessionId:"${sessionId}", netId:"${netId}"}` : '';
  if (!def) {
    return [`not a definition yet: update_net_definition {action:"create"} or add one to this net${where}`];
  }
  const out: string[] = [];
  const builds: any[] = Array.isArray(detail?.builds) ? detail.builds.map(buildSummary) : [];
  const open = builds.find((b) => b.state && !TERMINAL_STATES.has(b.state));
  const questions = openQuestions(detail).length;
  const status = String(def.status ?? 'draft');
  const revision = Number(def.revision ?? 1);
  const realizedRevision = def.realizedRevision != null ? Number(def.realizedRevision) : null;

  if (open) {
    if (open.cancelRequested) {
      out.push(`build ${open.buildId} has a cancel request: settle active work, then claim_net_definition {action:"release", state:"cancelled"}`);
    } else if (open.state === 'queued') {
      out.push(`claim build ${open.buildId}: claim_net_definition {buildId:"${open.buildId}", owner, action:"claim"}`);
    } else if (open.state === 'awaiting-answers') {
      if (questions > 0) {
        out.push(`answer ${questions} open question${questions === 1 ? '' : 's'} (Explorer or application_action interview respond) before build ${open.buildId} can resume`);
      } else {
        out.push(`answers are in: claim build ${open.buildId} again and reread the definition and answers`);
      }
    } else if (ACTIVE_STATES.has(open.state)) {
      if (leaseExpired(open, now)) {
        out.push(`build ${open.buildId} lease expired (${open.state}): claim it to resume from its checkpoint`);
      } else {
        out.push(`build ${open.buildId} is held by ${open.owner ?? 'another builder'} until ${open.leaseExpiresAt}; wait or ask the owner`);
      }
    }
    return out;
  }
  if (questions > 0) {
    out.push(`answer ${questions} open question${questions === 1 ? '' : 's'} on this definition`);
  }
  if (status === 'draft') {
    out.push(`mark ready when the description is complete: update_net_definition {action:"ready"${where ? `, sessionId:"${sessionId}", netId:"${netId}"` : ''}}`);
  } else if (status === 'ready') {
    out.push(`request a build: update_net_definition {action:"request_build"${where ? `, sessionId:"${sessionId}", netId:"${netId}"` : ''}}`);
  } else if (status === 'realized') {
    if (realizedRevision != null && revision > realizedRevision) {
      out.push(`changes pending: revision ${revision} is newer than the realized revision ${realizedRevision}; mark ready and request a build`);
    } else {
      out.push(`realized at revision ${realizedRevision ?? revision}; nothing to build`);
    }
  } else if (status === 'archived') {
    out.push('archived: excluded from active work');
  }
  return out;
}

function matchesQuery(row: any, query: string): boolean {
  const q = query.toLowerCase();
  return [row?.key, row?.title, row?.description, row?.interactions]
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

/** Join the catalogue's definitions with their nets: one compact row per definition. */
export function definitionRows(catalogue: any): any[] {
  const nets: any[] = Array.isArray(catalogue?.nets) ? catalogue.nets : [];
  const byKey = new Map<string, any>(nets.map((n) => [String(n?.key ?? ''), n]));
  const defs: any[] = Array.isArray(catalogue?.definitions) ? catalogue.definitions : [];
  return defs.map((d) => {
    const sessionId = d?.ref?.sessionId;
    const netId = d?.ref?.netId;
    const key = d?.key ?? (sessionId && netId ? `${sessionId}::${netId}` : undefined);
    const net = key ? byKey.get(key) : undefined;
    const parent = net?.parent;
    return {
      key,
      sessionId,
      netId,
      title: net?.title ?? netId,
      description: net?.description ?? null,
      status: d?.status ?? net?.definitionStatus ?? 'draft',
      revision: d?.revision ?? 1,
      depth: net?.depth ?? 0,
      parent: parent?.ref?.sessionId && parent?.ref?.netId
        ? `${parent.ref.sessionId}::${parent.ref.netId}#${parent.elementId}`
        : null,
      interactions: d?.interactions ?? null,
      layerAbove: d?.layerAbove ?? null,
      layerBelow: d?.layerBelow ?? null,
      placeCount: net?.placeCount ?? 0,
      transitionCount: net?.transitionCount ?? 0,
    };
  });
}

export const RELATIONS = ['explains', 'depends-on', 'references'] as const;
type Relation = { relation: string; target: { sessionId: string; netId: string }; note?: string };

function relationKey(r: Relation): string {
  return `${r.relation}>${r.target.sessionId}::${r.target.netId}`;
}

/** The relations a net declares today, read from the catalogue's `relations` list. */
export function currentRelations(catalogue: any, fromKey: string): Relation[] {
  const all: any[] = Array.isArray(catalogue?.relations) ? catalogue.relations : [];
  const out: Relation[] = [];
  for (const r of all) {
    if (r?.fromKey !== fromKey || typeof r?.relation !== 'string') continue;
    let sessionId = r?.to?.sessionId;
    let netId = r?.to?.netId;
    if ((!sessionId || !netId) && typeof r?.toKey === 'string' && r.toKey.includes('::')) {
      [sessionId, netId] = r.toKey.split('::');
    }
    if (!sessionId || !netId) continue;
    out.push({ relation: r.relation, target: { sessionId, netId }, ...(r.note ? { note: String(r.note) } : {}) });
  }
  return out;
}

/**
 * The list to send: master's relations route REPLACES a net's list, so add and remove merge with
 * what the catalogue holds. add updates the note of an existing relation; remove ignores notes.
 */
export function mergeRelations(current: Relation[], given: Relation[], mode: 'add' | 'remove' | 'replace'): Relation[] {
  if (mode === 'replace') return given;
  const out = [...current];
  for (const g of given) {
    const i = out.findIndex((c) => relationKey(c) === relationKey(g));
    if (mode === 'remove') {
      if (i >= 0) out.splice(i, 1);
    } else if (i >= 0) {
      out[i] = g;
    } else {
      out.push(g);
    }
  }
  return out;
}

const TEMPLATE_FIELDS = ['interactions', 'acceptance', 'proposedPorts', 'layerAbove', 'layerBelow',
  'layer', 'domain', 'responsible', 'tags', 'description'] as const;

/** Template skeleton under the explicit arguments: whatever the caller passes wins. */
export function mergeTemplate(template: any, args: any): Record<string, any> {
  const out: Record<string, any> = { ...args };
  const skeleton = template?.template ?? {};
  for (const k of TEMPLATE_FIELDS) {
    if (out[k] === undefined && skeleton[k] !== undefined) out[k] = skeleton[k];
  }
  return out;
}

/** Strip catalogue-only identity fields so the remainder can be written back as the property. */
/** The stored definition: the catalogue view minus identity and the build state it joins in. */
export function definitionBody(def: any): Record<string, any> {
  const { ref: _ref, key: _key, activeBuild: _a, latestBuildId: _b, latestBuildState: _c, ...rest } = def ?? {};
  return rest;
}

const placesSchema = z.record(z.string(), z.object({
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
}).passthrough()).describe('Places to draw in the definition net, keyed by place id. An id that already exists as a runtime place is REUSED (its tokens are never touched); a new id gets an empty runtime place.');

const transitionsSchema = z.record(z.string(), z.object({
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  inscription: z.record(z.string(), z.any()).optional(),
}).passthrough()).describe('Transitions keyed by id. inscription is the full runtime inscription (validated; errors reject the whole apply). A transition without an inscription is drawn only, e.g. an abstract element.');

export function registerDefinitionReaders(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'list_net_definitions',
    {
      title: 'List net definitions',
      description:
        'Natural-language net definitions of a model: persistent nets described in words before (or after) their topology exists, with status draft|ready|realized|archived, revision, depth and parent in the abstraction hierarchy. '
        + 'A definition with status ready, or one whose build is queued or awaiting answers, is claimable work: use get_net_definition for its next actions, or the realize-net-definition prompt to build it. '
        + 'Archived definitions are hidden unless status:"archived" or includeArchived:true. '
        + 'detail:"full" adds the open-question count per definition (one extra read each, at most 25). Read-only.',
      inputSchema: {
        status: z.enum(['draft', 'ready', 'realized', 'archived']).optional(),
        includeArchived: z.boolean().optional().describe('Archived definitions are hidden unless status:"archived" or this is true'),
        query: z.string().optional().describe('Substring filter on key, title, description or interactions'),
        detail: z.enum(['summary', 'full']).default('summary'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'list_net_definitions', mutates: false }, async (model, args) => {
      const catalogue = await masterCall(ctx, 'GET', explorerPath(model, '/catalogue'));
      const all = definitionRows(catalogue);
      const showArchived = args.status === 'archived' || args.includeArchived === true;
      const visible = showArchived ? all : all.filter((r) => r.status !== 'archived');
      let rows = args.status ? visible.filter((r) => r.status === args.status) : visible;
      if (args.query) rows = rows.filter((r) => matchesQuery(r, args.query));
      let truncated = false;
      if (args.detail === 'full') {
        const slice = rows.slice(0, FULL_DETAIL_CAP);
        truncated = rows.length > slice.length;
        for (const row of slice) {
          try {
            const detail = await masterCall(ctx, 'GET',
              explorerPath(model, `/definitions/${seg(row.sessionId)}/${seg(row.netId)}`));
            row.openQuestions = openQuestions(detail).length;
            row.builds = (Array.isArray(detail?.builds) ? detail.builds : []).map(buildSummary);
          } catch (err: any) {
            row.openQuestions = null;
            row.detailError = String(err?.message ?? err).slice(0, 200);
          }
        }
      }
      return {
        model,
        definitions: rows,
        total: all.length,
        matched: rows.length,
        ...(all.length > visible.length ? { archivedHidden: all.length - visible.length } : {}),
        ...(truncated ? { complete: false, note: `detail read for the first ${FULL_DETAIL_CAP} only` } : {}),
      };
    }),
  );

  server.registerTool(
    'get_net_definition',
    {
      title: 'Read one net definition',
      description:
        'One definition with its builds, open and answered questions (own and about its elements, subjectElement set), its curation (confirmations and open flags of the net and its elements), Interview support, and nextActions derived from its state. '
        + 'To ask the person a question about it, call application_action on application "interview", action "ask", with a NEW unique promptId (never reuse one), question, optional options (strings or {value,label,description,recommended}), multiSelect, allowFreeText, '
        + 'and the subject fields subjectKind:"net-definition", subjectKey:"<session>::<net>", subjectRevision:<revision>, refs:{"explorer.build":<open build>} (plus buildId:<open build> while Interview is older than 1.7.0). Then record_net_build checkpoint state:"awaiting-answers" (releases your lease) and come back later: claim again and reread this document; answers given in the Explorer or in your chat land in the same tokens. Read-only.',
      inputSchema: {
        sessionId: z.string().describe('Session of the definition net'),
        netId: z.string().describe('Net id of the definition'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'get_net_definition', mutates: false }, async (model, args) => {
      const detail = await masterCall(ctx, 'GET',
        explorerPath(model, `/definitions/${seg(args.sessionId)}/${seg(args.netId)}`));
      const builds = (Array.isArray(detail?.builds) ? detail.builds : []).map(buildSummary);
      const openBuild = builds.find((b: any) => b.state && !TERMINAL_STATES.has(b.state));
      const questions = detail?.questions ?? {};
      // The review state (the refinement's marks and questions): keep the net's own subjects and its
      // elements', the shape the definition detail used to carry.
      const netKey = `${args.sessionId}::${args.netId}`;
      const review = await refinementCall(ctx, 'GET', model, '/review').catch(() => null);
      let curation: any = detail?.curation ?? null;
      if (!curation && Array.isArray(review?.subjects)) {
        const elements: Record<string, unknown> = {};
        let own: unknown = null;
        for (const s of review.subjects) {
          const k = String(s?.subjectKey ?? '');
          if (k === netKey) own = s;
          else if (k.startsWith(netKey + '#')) elements[k.slice(netKey.length + 1)] = s;
        }
        curation = { installed: review?.curation?.installed ?? null, net: own, elements };
      }
      return {
        model,
        key: netKey,
        definition: detail?.definition ?? null,
        references: Array.isArray(detail?.definition?.references) ? detail.definition.references : [],
        templateId: detail?.definition?.templateId ?? null,
        net: detail?.net ?? null,
        builds,
        openBuild: openBuild ?? null,
        questions: {
          open: Array.isArray(questions.open) ? questions.open : [],
          answered: Array.isArray(questions.answered) ? questions.answered : [],
        },
        interview: detail?.interview ?? null,
        // The review state: confirmations and open flags of the net and its elements.
        curation,
        askWith: {
          application: 'interview',
          action: 'ask',
          subject: {
            subjectKind: 'net-definition',
            subjectKey: `${args.sessionId}::${args.netId}`,
            subjectRevision: detail?.definition?.revision ?? 1,
            // Interview 1.7.0 keeps the asking build under a namespaced reference; buildId stays for older installs.
            ...(openBuild?.buildId ? { refs: { 'explorer.build': openBuild.buildId }, buildId: openBuild.buildId } : {}),
          },
        },
        nextActions: nextActions(detail),
      };
    }),
  );

  server.registerTool(
    'list_net_definition_templates',
    {
      title: 'List net definition templates',
      description:
        'Reusable definition skeletons of a model (interactions, acceptance, proposed ports, levels, domain, responsible, tags, description). '
        + 'Start a definition from one with update_net_definition {action:"create", templateId}; explicit arguments win over the template. Read-only.',
      inputSchema: { ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'list_net_definition_templates', mutates: false }, async (model) => {
      const listed = await masterCall(ctx, 'GET', explorerPath(model, '/templates'));
      return { model, templates: Array.isArray(listed?.templates) ? listed.templates : [] };
    }),
  );
}

export function registerDefinitionTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  if (config.mode === 'readonly') return;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'update_net_definition',
    {
      title: 'Create, revise, ready, organize, relate, archive, or request a build of a net definition',
      description:
        'action:"create" makes a persistent empty net with name, description (what the net does) and a definition (interactions, proposedPorts, layerAbove, layerBelow, acceptance); parent {sessionId, netId, elementId, elementType} makes it the subnet of that element at once. '
        + 'action:"revise" writes a new revision (revision+1, history entry kept; status is kept, so a realized definition shows changes pending and can be rebuilt; description/name also update the net itself). '
        + 'action:"ready" marks the current revision ready to build. action:"request_build" opens a build for the current ready revision (policy.activate:true starts its transitions on completion; default stays stopped). '
        + 'action:"organize" sets organization on ANY net (definition or not): layer, domain (component), responsible (person), tags (replaces the list; [] clears), or clearLayer/clearDomain/clearResponsible; create also accepts layer, domain, responsible, tags. '
        + 'action:"relate" declares explicit relations from this net (any net) to others: relation explains|depends-on|references with target {sessionId, netId} and an optional note, or a relations list; mode add (default: merge, a repeat updates the note), remove, or replace (send exactly this list). refines is the subnet hierarchy, not a relation here. '
        + 'action:"archive" sets status archived (kept, hidden from active work and lists; refused while a build is open), action:"unarchive" restores the status it had (or realized when its revision was realized, else draft); neither bumps the revision. '
        + 'create also takes templateId (a template from net_definition_templates fills every field you do not pass; explicit args win) and references [{kind: doc|code|trace|data|record|web|<domain word>, uri, label}] stored in the definition (revise accepts references too). Designtime only.',
      inputSchema: {
        action: z.enum(['create', 'revise', 'ready', 'request_build', 'organize', 'relate', 'archive', 'unarchive']),
        sessionId: z.string().describe('Session of the definition (for create: where the new net is made)'),
        netId: z.string().optional().describe('Net id; required except for create, where it is derived from name when omitted'),
        name: z.string().optional(),
        description: z.string().optional().describe('What this net does, in natural language'),
        interactions: z.string().optional().describe('How it interacts with other nets, in natural language'),
        proposedPorts: z.array(z.object({ placeId: z.string(), role: z.enum(['input', 'output']) })).optional(),
        layerAbove: z.string().optional(),
        layerBelow: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        parent: z.object({
          sessionId: z.string(),
          netId: z.string(),
          elementId: z.string(),
          elementType: z.enum(['transition', 'place']).optional(),
        }).optional(),
        by: z.string().optional().describe('Who is acting (recorded in history / as requester)'),
        requestedBy: z.string().optional().describe('Alias of by'),
        policy: z.object({ activate: z.boolean().default(false) }).optional(),
        idempotencyKey: z.string().optional().describe('request_build: repeat-safe key; the same key returns the same build'),
        layer: z.string().optional().describe('create/organize: named level id (abstraction layer)'),
        domain: z.string().optional().describe('create/organize: domain or component the net belongs to'),
        responsible: z.string().optional().describe('create/organize: responsible person'),
        tags: z.array(z.string()).optional().describe('create/organize: tags; organize replaces the whole list, [] clears'),
        clearLayer: z.boolean().optional().describe('organize only'),
        clearDomain: z.boolean().optional().describe('organize only'),
        clearResponsible: z.boolean().optional().describe('organize only'),
        relation: z.enum(RELATIONS).optional().describe('relate: one relation (with target)'),
        target: z.object({ sessionId: z.string(), netId: z.string() }).optional().describe('relate: the related net'),
        note: z.string().optional().describe('relate: why the relation holds'),
        relations: z.array(z.object({
          relation: z.enum(RELATIONS),
          target: z.object({ sessionId: z.string(), netId: z.string() }),
          note: z.string().optional(),
        })).optional().describe('relate: several relations at once'),
        mode: z.enum(['add', 'remove', 'replace']).optional().describe('relate: add (default), remove, or replace the whole list'),
        templateId: z.string().optional().describe('create: start from this definition template'),
        references: z.array(z.object({
          kind: z.string().describe('doc | code | trace | data | record | web, or a word of the domain'),
          uri: z.string(),
          label: z.string().optional(),
        })).optional().describe('create/revise: where the knowledge lives: documents, code symbols, execution traces, datasets, records, web pages'),
        realizations: z.array(z.object({ sessionId: z.string(), netId: z.string(), role: z.string().optional() }))
          .optional().describe('create/revise: further nets this definition realizes; record_net_build apply may target them with net'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'update_net_definition', mutates: true }, async (model, rawArgs) => {
      let args: any = rawArgs;
      if (args.action === 'create' && args.templateId) {
        const listed = await masterCall(ctx, 'GET', explorerPath(model, '/templates'));
        const templates: any[] = Array.isArray(listed?.templates) ? listed.templates : [];
        const template = templates.find((t) => t?.id === args.templateId);
        if (!template) {
          throw new StructuredToolError({
            code: 'not-found',
            error: `no definition template ${args.templateId}; list them with list_net_definition_templates`,
          });
        }
        args = mergeTemplate(template, args);
      }
      if (args.action === 'create') {
        if (!args.name) throw new StructuredToolError({ code: 'missing-field', error: 'create needs name' });
        if (!args.description) throw new StructuredToolError({ code: 'missing-field', error: 'create needs description (what the net does)' });
        const definition: Record<string, any> = {};
        for (const k of ['interactions', 'proposedPorts', 'layerAbove', 'layerBelow', 'acceptance', 'references', 'templateId', 'realizations'] as const) {
          if (args[k] !== undefined) definition[k] = args[k];
        }
        const body: Record<string, any> = {
          sessionId: args.sessionId,
          ...(args.netId ? { netId: args.netId } : {}),
          name: args.name,
          description: args.description,
          definition,
          ...(args.parent ? { parent: { elementType: 'transition', ...args.parent } } : {}),
          ...organizationFields(args),
        };
        const created = await masterCall(ctx, 'POST', explorerPath(model, '/definitions'), body);
        return { action: 'create', model, ...created };
      }

      if (!args.netId) throw new StructuredToolError({ code: 'missing-field', error: `${args.action} needs netId` });
      const key = `${args.sessionId}::${args.netId}`;

      if (args.action === 'organize') {
        const body: Record<string, any> = organizationFields(args);
        for (const k of ['clearLayer', 'clearDomain', 'clearResponsible'] as const) {
          if (args[k] === true) body[k] = true;
        }
        if (Object.keys(body).length === 0) {
          throw new StructuredToolError({
            code: 'missing-field',
            error: 'organize needs at least one of layer, domain, responsible, tags, clearLayer, clearDomain, clearResponsible',
          });
        }
        const organizationPath = explorerPath(model, `/nets/${seg(args.sessionId)}/${seg(args.netId)}/organization`);
        const result = await masterCall(ctx, 'PUT', organizationPath, body);
        return { action: 'organize', model, key, set: body, result };
      }

      if (args.action === 'relate') {
        const given: Relation[] = Array.isArray(args.relations) ? [...args.relations] : [];
        if (args.relation && args.target) {
          given.push({ relation: args.relation, target: args.target, ...(args.note ? { note: args.note } : {}) });
        }
        const mode: 'add' | 'remove' | 'replace' = args.mode ?? 'add';
        if (given.length === 0 && mode !== 'replace') {
          throw new StructuredToolError({ code: 'missing-field', error: 'relate needs relation + target, or relations' });
        }
        const catalogue = mode === 'replace' ? null : await masterCall(ctx, 'GET', explorerPath(model, '/catalogue'));
        const current = catalogue ? currentRelations(catalogue, key) : [];
        const relations = mergeRelations(current, given, mode);
        const result = await masterCall(ctx, 'PUT',
          explorerPath(model, `/nets/${seg(args.sessionId)}/${seg(args.netId)}/relations`), { relations });
        return { action: 'relate', model, key, mode, relations, result };
      }

      if (args.action === 'request_build') {
        const body = {
          sessionId: args.sessionId,
          netId: args.netId,
          policy: { activate: args.policy?.activate === true },
          ...((args.by ?? args.requestedBy) ? { requestedBy: (args.by ?? args.requestedBy) } : {}),
          ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
        };
        const build = await masterCall(ctx, 'POST', explorerPath(model, '/builds'), body);
        return { action: 'request_build', model, key, build };
      }

      const detail = await masterCall(ctx, 'GET',
        explorerPath(model, `/definitions/${seg(args.sessionId)}/${seg(args.netId)}`));
      const current = detail?.definition;
      if (!current) {
        throw new StructuredToolError({ code: 'not-found', error: `${key} carries no definition; create one first` });
      }
      const organizationPath = explorerPath(model, `/nets/${seg(args.sessionId)}/${seg(args.netId)}/organization`);

      if (args.action === 'archive' || args.action === 'unarchive') {
        if (args.action === 'archive') {
          const open = (Array.isArray(detail?.builds) ? detail.builds : []).map(buildSummary)
            .find((b: any) => b.state && !TERMINAL_STATES.has(b.state));
          if (open) {
            throw new StructuredToolError({
              code: 'build-open',
              error: `build ${open.buildId} is still open; cancel it before archiving ${key}`,
              buildId: open.buildId,
            });
          }
        }
        // Same rule as the Explorer: archive remembers the status it left, unarchive restores it;
        // a record archived without that memory returns to realized when its revision was
        // realized, else to draft.
        const body: Record<string, any> = definitionBody(current);
        let next: Record<string, any>;
        if (args.action === 'archive') {
          next = { ...body, status: 'archived', archivedFrom: current.status === 'archived' ? (current.archivedFrom ?? null) : current.status };
        } else {
          const { archivedFrom, ...rest } = body;
          const realized = rest.realizedRevision != null && Number(rest.realizedRevision) >= Number(rest.revision ?? 1);
          const restoredStatus = archivedFrom && archivedFrom !== 'archived' ? archivedFrom : (realized ? 'realized' : 'draft');
          next = { ...rest, status: restoredStatus };
        }
        const status = next.status;
        await masterCall(ctx, 'PUT', organizationPath, { definition: next });
        return { action: args.action, model, key, revision: next.revision ?? 1, status };
      }

      if (args.action === 'ready') {
        const next: Record<string, any> = { ...definitionBody(current), status: 'ready' };
        await masterCall(ctx, 'PUT', organizationPath, { definition: next });
        return { action: 'ready', model, key, revision: next.revision ?? 1, status: 'ready' };
      }

      // revise
      const base = definitionBody(current);
      const revision = Number(base.revision ?? 1) + 1;
      const next: Record<string, any> = { ...base, revision };
      for (const k of ['interactions', 'proposedPorts', 'layerAbove', 'layerBelow', 'acceptance', 'references', 'realizations'] as const) {
        if (args[k] !== undefined) next[k] = args[k];
      }
      const description = args.description ?? detail?.net?.description ?? '';
      const history = Array.isArray(base.history) ? [...base.history] : [];
      history.push({
        revision,
        at: new Date().toISOString(),
        by: (args.by ?? args.requestedBy) ?? '',
        description,
        interactions: next.interactions ?? '',
      });
      next.history = history;
      if (args.description !== undefined || args.name !== undefined) {
        // The description lives on the net itself (pnml/net/description); the designtime create
        // route converges on an existing net and refreshes name/description only.
        await masterCall(ctx, 'POST', '/designtime/nets', {
          modelId: model,
          sessionId: args.sessionId,
          netId: args.netId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        });
      }
      await masterCall(ctx, 'PUT', organizationPath, { definition: next });
      return { action: 'revise', model, key, revision, status: next.status };
    }),
  );

  server.registerTool(
    'net_definition_templates',
    {
      title: 'List, save or delete net definition templates',
      description:
        'action:"list" returns the model\'s templates; action:"save" creates or replaces one by templateId with name, description and template {interactions, acceptance, proposedPorts, layer, domain, responsible, tags, description}; action:"delete" removes it. '
        + 'Templates are shared designtime documents; deleting one never touches a definition made from it.',
      inputSchema: {
        action: z.enum(['list', 'save', 'delete']),
        templateId: z.string().optional().describe('save/delete: stable id (letters, digits, . _ -)'),
        name: z.string().optional().describe('save: display name'),
        description: z.string().optional().describe('save: what the template is for'),
        template: z.object({
          interactions: z.string().optional(),
          acceptance: z.array(z.string()).optional(),
          proposedPorts: z.array(z.object({ placeId: z.string(), role: z.enum(['input', 'output']) })).optional(),
          layer: z.string().optional(),
          domain: z.string().optional(),
          responsible: z.string().optional(),
          tags: z.array(z.string()).optional(),
          description: z.string().optional(),
        }).passthrough().optional().describe('save: the definition skeleton'),
        by: z.string().optional().describe('save: who is saving'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'net_definition_templates', mutates: true }, async (model, args) => {
      if (args.action === 'list') {
        const listed = await masterCall(ctx, 'GET', explorerPath(model, '/templates'));
        return { action: 'list', model, templates: Array.isArray(listed?.templates) ? listed.templates : [] };
      }
      if (!args.templateId) {
        throw new StructuredToolError({ code: 'missing-field', error: `${args.action} needs templateId` });
      }
      const route = explorerPath(model, `/templates/${seg(args.templateId)}`);
      if (args.action === 'delete') {
        const result = await masterCall(ctx, 'DELETE', route);
        return { action: 'delete', model, templateId: args.templateId, result };
      }
      if (!args.name) throw new StructuredToolError({ code: 'missing-field', error: 'save needs name' });
      const body: Record<string, any> = {
        name: args.name,
        ...(args.description ? { description: args.description } : {}),
        template: args.template ?? {},
        ...(args.by ? { updatedBy: args.by } : {}),
      };
      const saved = await masterCall(ctx, 'PUT', route, body);
      return { action: 'save', model, templateId: args.templateId, template: saved };
    }),
  );

  server.registerTool(
    'claim_net_definition',
    {
      title: 'Claim, renew or release a definition build lease',
      description:
        'action:"claim" takes the build lease (queued, awaiting-answers, or an expired lease) and returns leaseGeneration; pass that generation on every later call. Pass buildId, or sessionId+netId to use the definition\'s open build. '
        + 'action:"renew" extends a live lease during long work. action:"release" gives it back with state queued, awaiting-answers (waiting for answers) or cancelled (only after a cancel request). '
        + 'A 409 code lease-lost / superseded / cancel-requested means stop and reread get_net_definition; never build on a lost lease.',
      inputSchema: {
        action: z.enum(['claim', 'renew', 'release']),
        owner: z.string().describe('Stable builder id (your client/persona name)'),
        buildId: z.string().optional(),
        sessionId: z.string().optional(),
        netId: z.string().optional(),
        leaseGeneration: z.number().int().optional().describe('Required for renew and release'),
        leaseSeconds: z.number().int().min(1).max(900).optional(),
        state: z.enum(['queued', 'awaiting-answers', 'cancelled']).optional().describe('release only'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'claim_net_definition', mutates: true }, async (model, args) => {
      let buildId: string | undefined = args.buildId;
      if (!buildId) {
        if (!args.sessionId || !args.netId) {
          throw new StructuredToolError({ code: 'missing-field', error: 'pass buildId, or sessionId and netId of the definition' });
        }
        const detail = await masterCall(ctx, 'GET',
          explorerPath(model, `/definitions/${seg(args.sessionId)}/${seg(args.netId)}`));
        const open = (Array.isArray(detail?.builds) ? detail.builds : []).map(buildSummary)
          .find((b: any) => b.state && !TERMINAL_STATES.has(b.state));
        if (!open?.buildId) {
          throw new StructuredToolError({ code: 'not-found', error: `no open build for ${args.sessionId}::${args.netId}; request one with update_net_definition action:"request_build"` });
        }
        buildId = open.buildId;
      }
      if (args.action !== 'claim' && args.leaseGeneration === undefined) {
        throw new StructuredToolError({ code: 'missing-field', error: `${args.action} needs leaseGeneration from your claim` });
      }
      const body: Record<string, any> = { owner: args.owner };
      if (args.leaseGeneration !== undefined && args.action !== 'claim') body.leaseGeneration = args.leaseGeneration;
      if (args.leaseSeconds !== undefined && args.action !== 'release') body.leaseSeconds = args.leaseSeconds;
      if (args.action === 'release' && args.state) body.state = args.state;
      const result = await masterCall(ctx, 'POST', explorerPath(model, `/builds/${seg(buildId!)}/${args.action}`), body);
      return { action: args.action, model, buildId, result };
    }),
  );

  server.registerTool(
    'record_net_build',
    {
      title: 'Record a build step: checkpoint, apply, complete, fail, cancel',
      description:
        'Every action except cancel needs owner + leaseGeneration from claim_net_definition; master fences each one. '
        + 'checkpoint: state planning|building|verifying|awaiting-answers (awaiting-answers releases the lease), a free checkpoint object, and optionally plan {revision, summary, assumptions[], reusedPlaces[], topology, acceptance[]} (the server records a boundary hash over reusedPlaces; apply fails with boundary-changed if those places changed). '
        + 'apply: places, transitions (with inscriptions), optional arcs (derived from presets/postsets when omitted), optional remove {places, transitions, arcs}; one atomic write into the definition net, diff-based (a retry changes nothing), validated, never starts anything, never touches tokens. '
        + 'complete: verification {passed, evidence[]} and notes; marks the definition realized; when the build policy says activate, the listed transitions are started here and reported per id. '
        + 'fail: error and evidence; earlier realizations stay intact. cancel: requests cancellation (no lease needed).',
      inputSchema: {
        action: z.enum(['checkpoint', 'apply', 'complete', 'fail', 'cancel']),
        buildId: z.string(),
        owner: z.string().optional().describe('Required except for cancel'),
        leaseGeneration: z.number().int().optional().describe('Required except for cancel'),
        state: z.enum(['planning', 'building', 'verifying', 'awaiting-answers']).optional().describe('checkpoint only'),
        checkpoint: z.record(z.string(), z.any()).optional(),
        plan: z.record(z.string(), z.any()).optional(),
        places: placesSchema.optional(),
        transitions: transitionsSchema.optional(),
        arcs: z.array(z.object({ source: z.string(), target: z.string() })).optional(),
        remove: z.object({
          places: z.array(z.string()).optional(),
          transitions: z.array(z.string()).optional(),
          arcs: z.array(z.string()).optional(),
        }).optional(),
        net: z.object({ sessionId: z.string(), netId: z.string() }).optional()
          .describe('apply only: draw into this net instead of the definition net; it must be one of the definition\'s realizations'),
        verification: z.object({
          passed: z.boolean(),
          evidence: z.array(z.any()).default([]),
        }).optional(),
        notes: z.string().optional(),
        error: z.string().optional().describe('fail only'),
        evidence: z.array(z.any()).optional().describe('fail only'),
        requestedBy: z.string().optional().describe('cancel only'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'record_net_build', mutates: true }, async (model, args) => {
      const route = explorerPath(model, `/builds/${seg(args.buildId)}/${args.action}`);
      if (args.action === 'cancel') {
        const result = await masterCall(ctx, 'POST', route, args.requestedBy ? { requestedBy: args.requestedBy } : {});
        return { action: 'cancel', model, buildId: args.buildId, result };
      }
      if (!args.owner || args.leaseGeneration === undefined) {
        throw new StructuredToolError({ code: 'missing-field', error: `${args.action} needs owner and leaseGeneration from your claim` });
      }
      const fence = { owner: args.owner, leaseGeneration: args.leaseGeneration };
      let body: Record<string, any>;
      switch (args.action) {
        case 'checkpoint':
          body = {
            ...fence,
            ...(args.state ? { state: args.state } : {}),
            ...(args.checkpoint ? { checkpoint: args.checkpoint } : {}),
            ...(args.plan ? { plan: args.plan } : {}),
          };
          break;
        case 'apply':
          body = {
            ...fence,
            places: args.places ?? {},
            transitions: args.transitions ?? {},
            ...(args.arcs ? { arcs: args.arcs } : {}),
            ...(args.remove ? { remove: args.remove } : {}),
            ...(args.net ? { net: args.net } : {}),
          };
          break;
        case 'complete':
          body = {
            ...fence,
            ...(args.verification ? { verification: args.verification } : {}),
            ...(args.notes ? { notes: args.notes } : {}),
          };
          break;
        default: // fail
          body = {
            ...fence,
            error: args.error ?? 'build failed',
            ...(args.evidence ? { evidence: args.evidence } : {}),
          };
      }
      const result = await masterCall(ctx, 'POST', route, body);
      if (args.action !== 'complete') {
        return { action: args.action, model, buildId: args.buildId, result };
      }
      const activation = result?.activation;
      const ids: string[] = Array.isArray(activation?.transitionIds) ? activation.transitionIds : [];
      if (activation?.activate !== true || ids.length === 0) {
        return {
          action: 'complete', model, buildId: args.buildId, result,
          started: [],
          note: 'policy keeps the realized net stopped; start_transition / start_net when you choose to run it',
        };
      }
      const started: any[] = [];
      for (const id of ids) {
        try {
          await ctx.master.startTransition(id, model);
          started.push({ transitionId: id, started: true });
        } catch (err: any) {
          started.push({ transitionId: id, started: false, error: String(err?.message ?? err).slice(0, 300) });
        }
      }
      return { action: 'complete', model, buildId: args.buildId, result, started };
    }),
  );
}
