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
async function masterCall(ctx: AppContext, method: string, path: string, body?: any): Promise<any> {
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

/** Strip catalogue-only identity fields so the remainder can be written back as the property. */
function definitionBody(def: any): Record<string, any> {
  const { ref: _ref, key: _key, ...rest } = def ?? {};
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
        + 'detail:"full" adds the open-question count per definition (one extra read each, at most 25). Read-only.',
      inputSchema: {
        status: z.enum(['draft', 'ready', 'realized', 'archived']).optional(),
        query: z.string().optional().describe('Substring filter on key, title, description or interactions'),
        detail: z.enum(['summary', 'full']).default('summary'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'list_net_definitions', mutates: false }, async (model, args) => {
      const catalogue = await masterCall(ctx, 'GET', explorerPath(model, '/catalogue'));
      const all = definitionRows(catalogue);
      let rows = args.status ? all.filter((r) => r.status === args.status) : all;
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
        ...(truncated ? { complete: false, note: `detail read for the first ${FULL_DETAIL_CAP} only` } : {}),
      };
    }),
  );

  server.registerTool(
    'get_net_definition',
    {
      title: 'Read one net definition',
      description:
        'One definition with its builds, open and answered questions, Interview support, and nextActions derived from its state. '
        + 'To ask the person a question about it, call application_action on application "interview", action "ask", with a NEW unique promptId (never reuse one), question, optional options (strings or {value,label,description,recommended}), multiSelect, allowFreeText, '
        + 'and the subject fields subjectKind:"net-definition", subjectKey:"<session>::<net>", subjectRevision:<revision>, buildId:<open build>. Then record_net_build checkpoint state:"awaiting-answers" (releases your lease) and come back later: claim again and reread this document; answers given in the Explorer or in your chat land in the same tokens. Read-only.',
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
      return {
        model,
        key: `${args.sessionId}::${args.netId}`,
        definition: detail?.definition ?? null,
        net: detail?.net ?? null,
        builds,
        openBuild: openBuild ?? null,
        questions: {
          open: Array.isArray(questions.open) ? questions.open : [],
          answered: Array.isArray(questions.answered) ? questions.answered : [],
        },
        interview: detail?.interview ?? null,
        askWith: {
          application: 'interview',
          action: 'ask',
          subject: {
            subjectKind: 'net-definition',
            subjectKey: `${args.sessionId}::${args.netId}`,
            subjectRevision: detail?.definition?.revision ?? 1,
            ...(openBuild?.buildId ? { buildId: openBuild.buildId } : {}),
          },
        },
        nextActions: nextActions(detail),
      };
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
      title: 'Create, revise, ready, or request a build of a net definition',
      description:
        'action:"create" makes a persistent empty net with name, description (what the net does) and a definition (interactions, proposedPorts, layerAbove, layerBelow, acceptance); parent {sessionId, netId, elementId, elementType} makes it the subnet of that element at once. '
        + 'action:"revise" writes a new revision (revision+1, history entry kept; status is kept, so a realized definition shows changes pending and can be rebuilt; description/name also update the net itself). '
        + 'action:"ready" marks the current revision ready to build. action:"request_build" opens a build for the current ready revision (policy.activate:true starts its transitions on completion; default stays stopped). Designtime only.',
      inputSchema: {
        action: z.enum(['create', 'revise', 'ready', 'request_build']),
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
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'update_net_definition', mutates: true }, async (model, args) => {
      if (args.action === 'create') {
        if (!args.name) throw new StructuredToolError({ code: 'missing-field', error: 'create needs name' });
        if (!args.description) throw new StructuredToolError({ code: 'missing-field', error: 'create needs description (what the net does)' });
        const definition: Record<string, any> = {};
        for (const k of ['interactions', 'proposedPorts', 'layerAbove', 'layerBelow', 'acceptance'] as const) {
          if (args[k] !== undefined) definition[k] = args[k];
        }
        const body: Record<string, any> = {
          sessionId: args.sessionId,
          ...(args.netId ? { netId: args.netId } : {}),
          name: args.name,
          description: args.description,
          definition,
          ...(args.parent ? { parent: { elementType: 'transition', ...args.parent } } : {}),
        };
        const created = await masterCall(ctx, 'POST', explorerPath(model, '/definitions'), body);
        return { action: 'create', model, ...created };
      }

      if (!args.netId) throw new StructuredToolError({ code: 'missing-field', error: `${args.action} needs netId` });
      const key = `${args.sessionId}::${args.netId}`;

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

      if (args.action === 'ready') {
        const next: Record<string, any> = { ...definitionBody(current), status: 'ready' };
        await masterCall(ctx, 'PUT', organizationPath, { definition: next });
        return { action: 'ready', model, key, revision: next.revision ?? 1, status: 'ready' };
      }

      // revise
      const base = definitionBody(current);
      const revision = Number(base.revision ?? 1) + 1;
      const next: Record<string, any> = { ...base, revision };
      for (const k of ['interactions', 'proposedPorts', 'layerAbove', 'layerBelow', 'acceptance'] as const) {
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
