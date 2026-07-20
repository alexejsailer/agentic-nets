/**
 * Kind-aware inscription builders — the pre-wired templates that make
 * LLM-authored transitions runnable by construction (the Forge lesson:
 * raw inscription authoring is the #1 failure mode, so every kind ships
 * a known-good default and callers only fill in the variable parts).
 *
 * Engine gotchas baked in:
 * - presets ALWAYS carry a non-empty `arcql` (an empty one makes master's
 *   execution-status polling spam 400s against node — even for kind:link).
 * - llm actions get an explicit `timeoutMs` (LlmActionHandler defaults to 60s,
 *   which real grounded prompts blow) and support `model` overrides.
 * - every non-link inscription has a catch-all emit (token-loss prevention).
 */
import type { AppContext } from './context.js';

export interface PresetSpec {
  placeId: string;
  host: string;
  arcql?: string;
  take?: 'FIRST' | 'ALL';
  consume?: boolean;
  optional?: boolean;
}

function preset(placeId: string, host: string, over: Partial<PresetSpec> = {}): PresetSpec {
  return { placeId, host, arcql: 'FROM $ LIMIT 1', take: 'FIRST', consume: true, ...over };
}

export interface BuildOpts {
  id: string;
  label?: string;
  /** link — typed edge semantics (what TARGET is to SOURCE), e.g. contains | derives-from. */
  relation?: string;
  description?: string;
  host: string;
  inputPlace: string;
  outputPlace: string;
  /** 6-field cron or interval ms — either arms a schedule. */
  scheduleCron?: string;
  intervalMs?: number;
  timeoutMs?: number;
  /** Execution mode: SINGLE (bind all presets, fire once) or FOREACH (process each bound token
   *  independently, bounded parallel fan-out). Default SINGLE. */
  mode?: 'SINGLE' | 'FOREACH';
  /** llm */
  prompt?: string;
  llmModel?: string;
  /** http */
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  /** http auth (e.g. {type:"bearer", credentialKey:"API_TOKEN"} — resolved via ${credentials.*}). */
  auth?: Record<string, any>;
  retry?: Record<string, any>;
  /** Override the default emit rules verbatim (advanced). */
  emit?: any[];
  /** map/llm/http: verdict/branch routing — one postset + one when-gated emit per route, mutually
   *  exclusive conditions, no catch-all (docs/emit). Lets you build review/branch lanes without
   *  hand-authoring an inscription. */
  routes?: { place: string; when: string }[];
  /** http/llm: a place to route errors to (adds an `err` postset + a when:"error" emit). */
  errorPlace?: string;
  /** map */
  template?: Record<string, any>;
  /** command — which executor runs it ('*' = any executor; omitted = default executor) */
  executorId?: string;
  /** output capacity */
  capacity?: number;
  /** agent — autonomous multi-step persona (rwxhludcts capability gating + tier-selected LLM) */
  netModel?: string;
  role?: string;
  nl?: string;
  tier?: string;
  maxIterations?: number;
  autoEmit?: boolean;
}

/**
 * Validate a cron expression before it is baked into an inscription. The engine uses SIX-field
 * cron (second minute hour day-of-month month day-of-week), so the #1 real-world mistake is
 * pasting a standard 5-field crontab line (e.g. "0 8 * * *") which is silently accepted and then
 * either never fires or fires at the wrong field — the classic "my scheduled lane went silent"
 * trap. Throws an actionable error rather than persisting a dud schedule. Light by design: it
 * checks the field count and per-field character set (digits, * ? , - / and month/day names),
 * not full range semantics, so it never rejects a valid Spring cron.
 */
export function validateCron(cron: string): void {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 6) {
    throw new Error(
      `Invalid cron "${cron}": expected 6 fields "sec min hour day month weekday" ` +
        `(e.g. "0 0 8 * * *" = 08:00 daily). Got ${fields.length} field(s) — a standard 5-field ` +
        `crontab line is NOT accepted; prepend a seconds field.`,
    );
  }
  const token = /^[0-9*?,\/\-A-Za-z]+$/;
  const bad = fields.find((f) => !token.test(f));
  if (bad !== undefined) {
    throw new Error(`Invalid cron "${cron}": field "${bad}" contains unsupported characters.`);
  }
}

function schedule(opts: BuildOpts): Record<string, any> {
  if (opts.scheduleCron) {
    validateCron(opts.scheduleCron);
    return { schedule: { type: 'cron', cron: opts.scheduleCron } };
  }
  if (opts.intervalMs) return { schedule: { type: 'interval', intervalMs: opts.intervalMs } };
  return {};
}

function postset(opts: BuildOpts) {
  return {
    out: {
      placeId: opts.outputPlace,
      host: opts.host,
      ...(opts.capacity ? { capacity: opts.capacity } : {}),
    },
  };
}

/** Derive a stable, collision-free postset key from a place id (p-approved → approved). */
function routeKey(place: string, taken: Set<string>): string {
  const base = place.replace(/^p-/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'r';
  let key = base;
  let i = 1;
  while (taken.has(key)) key = `${base}_${i++}`;
  taken.add(key);
  return key;
}

/**
 * Verdict/branch routing: turn opts.routes into one postset + one when-gated emit PER route.
 * `from` is the kind's result expression (llm/http: @response.json, map: @response). Conditions
 * must be mutually exclusive and cover the value space — there is deliberately NO catch-all, so an
 * unexpected value leaves the input unconsumed and visible rather than duplicated (docs/emit).
 * Returns null when no routes are set. Reuses the `out`/`err` keys so a route may target the
 * declared output or error place. Lets a pure-MCP client build review/branch lanes without
 * hand-authoring SET_INSCRIPTION.
 */
function routeSplit(opts: BuildOpts, from: string): { postsets: Record<string, any>; emit: any[] } | null {
  if (!opts.routes || opts.routes.length === 0) return null;
  const postsets: Record<string, any> = {};
  const emit: any[] = [];
  const taken = new Set<string>(['out', 'err']);
  for (const r of opts.routes) {
    const key = r.place === opts.outputPlace ? 'out' : r.place === opts.errorPlace ? 'err' : routeKey(r.place, taken);
    postsets[key] = { placeId: r.place, host: opts.host, ...(opts.capacity ? { capacity: opts.capacity } : {}) };
    emit.push({ to: key, from, when: r.when });
  }
  return { postsets, emit };
}

export function buildLinkInscription(
  id: string,
  label: string,
  from: string,
  to: string,
  host: string,
  relation?: string,
) {
  return {
    id,
    kind: 'link',
    // relation is the typed edge semantics (what TARGET is to SOURCE); label stays human-readable
    // free text. label defaults from relation, but NOT vice versa — copying prose labels into
    // relation would trip the master's LINK_UNKNOWN_RELATION vocabulary warning on every link.
    label: label || relation || id,
    ...(relation ? { relation } : {}),
    presets: { from: preset(from, host, { consume: false, optional: true }) },
    postsets: { to: { placeId: to, host } },
  };
}

export function buildMapInscription(opts: BuildOpts) {
  const routed = routeSplit(opts, '@response');
  return {
    id: opts.id,
    kind: 'map',
    label: opts.label ?? opts.id,
    ...schedule(opts),
    presets: { input: preset(opts.inputPlace, opts.host, opts.scheduleCron || opts.intervalMs ? { consume: false, optional: true } : {}) },
    postsets: { ...postset(opts), ...(routed?.postsets ?? {}) },
    action: { type: 'map', template: opts.template ?? { value: '${input.data}' } },
    emit: opts.emit ?? routed?.emit ?? [{ to: 'out', from: '@response' }],
    mode: opts.mode ?? 'SINGLE',
  };
}

export function buildLlmInscription(opts: BuildOpts) {
  const postsets: Record<string, any> = postset(opts);
  if (opts.errorPlace) {
    postsets.err = { placeId: opts.errorPlace, host: opts.host };
  }
  // Verdict routing: one postset+emit per route (structured verdict via @response.json). errorPlace
  // still adds an err branch on top.
  const routed = routeSplit(opts, '@response.json');
  if (routed) Object.assign(postsets, routed.postsets);
  // With an errorPlace, split success vs error so a failed llm call (bad prompt, provider
  // down, unparseable response) lands somewhere visible instead of being silently dropped —
  // master 2.28+ builds errorPayloads from the when:"error" emit rules on every failure path,
  // mirroring the http lane.
  const emit = opts.emit ?? (routed
    ? [...routed.emit, ...(opts.errorPlace ? [{ to: 'err', from: '@response', when: 'error' }] : [])]
    : [
        // @response.json, NOT @response.raw: raw stores the reply as a JSON-escaped string under
        // `value`, so a prompt-for-JSON lane (the common case) can never interpolate its fields
        // downstream — proven live (release-radar: headline/impact arrived double-encoded and the
        // board post interpolated empty). Parsed fields land as top-level data properties; on
        // masters ≥ 2.28 a parse failure routes to the err branch when errorPlace is set.
        { to: 'out', from: '@response.json', ...(opts.errorPlace ? { when: 'success' } : {}) },
        ...(opts.errorPlace ? [{ to: 'err', from: '@response', when: 'error' }] : []),
      ]);
  return {
    id: opts.id,
    kind: 'llm',
    label: opts.label ?? opts.id,
    ...schedule(opts),
    presets: {
      input: preset(
        opts.inputPlace,
        opts.host,
        opts.scheduleCron || opts.intervalMs ? { consume: false, optional: true } : {},
      ),
    },
    postsets,
    action: {
      type: 'llm',
      nl: opts.prompt ?? '${input.data.prompt}',
      ...(opts.llmModel ? { model: opts.llmModel } : {}),
      // Master ≥ 2.28 resolves action.tier via LlmTierResolver (explicit model
      // wins). Forwarding it here is what makes `tier` on kind:llm real — a
      // dropped tier silently hands the caller the EXPENSIVE base model.
      ...(opts.tier ? { tier: opts.tier } : {}),
      timeoutMs: opts.timeoutMs ?? 240000,
    },
    emit,
    mode: opts.mode ?? 'SINGLE',
  };
}

/**
 * Translate the ergonomic auth shape this tool advertises ({type, credentialKey}) into the shape
 * the master's HttpActionHandler.applyAuth actually reads: `params.token` (bearer) / `params.apiKey`
 * (api_key) / `params.username|password` (basic), each a `${credentials.KEY}` template the master
 * interpolates at fire time. WITHOUT this, `auth:{type:"bearer", credentialKey:"X"}` silently sends
 * NO Authorization header (applyAuth reads params.token, which is absent) — a 401 with no clue.
 * Anything that already supplies `params` (advanced / oauth2_client_credentials) passes through
 * unchanged, as does an unrecognised type.
 */
export function normalizeAuth(auth: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!auth || typeof auth !== 'object' || auth.params) return auth;
  const type = String(auth.type ?? '').toLowerCase();
  const credTpl = (key: string) => '${credentials.' + key + '}';
  if (type === 'bearer') {
    const token = auth.token ?? (auth.credentialKey ? credTpl(auth.credentialKey) : undefined);
    return token ? { type: 'bearer', params: { token } } : auth;
  }
  if (type === 'api_key' || type === 'apikey') {
    const apiKey = auth.apiKey ?? (auth.credentialKey ? credTpl(auth.credentialKey) : undefined);
    if (!apiKey) return auth;
    const params: Record<string, string> = { apiKey };
    if (auth.name) params.name = auth.name;
    if (auth.in) params.in = auth.in;
    return { type: 'api_key', params };
  }
  if (type === 'basic') {
    const params: Record<string, string> = {};
    if (auth.username) params.username = auth.username;
    if (auth.usernameKey) params.username = credTpl(auth.usernameKey);
    if (auth.password) params.password = auth.password;
    if (auth.passwordKey ?? auth.credentialKey) params.password = credTpl(auth.passwordKey ?? auth.credentialKey);
    return Object.keys(params).length ? { type: 'basic', params } : auth;
  }
  return auth;
}

export function buildHttpInscription(opts: BuildOpts) {
  const postsets: Record<string, any> = postset(opts);
  if (opts.errorPlace) {
    postsets.err = { placeId: opts.errorPlace, host: opts.host };
  }
  const action: Record<string, any> = {
    type: 'http',
    method: opts.method ?? 'GET',
    url: opts.url ?? '${input.data.url}',
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.auth ? { auth: normalizeAuth(opts.auth) } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    timeoutMs: opts.timeoutMs ?? 30000,
  };
  // Verdict routing: one postset+emit per route (parsed body via @response.json). errorPlace still
  // adds an err branch on top.
  const routed = routeSplit(opts, '@response.json');
  if (routed) Object.assign(postsets, routed.postsets);
  // Default emit routes the JSON body to the output; with an errorPlace, split success vs error
  // so a failed call lands somewhere visible instead of being silently dropped.
  const emit = opts.emit ?? (routed
    ? [...routed.emit, ...(opts.errorPlace ? [{ to: 'err', from: '@response', when: 'error' }] : [])]
    : [
        { to: 'out', from: '@response.json', ...(opts.errorPlace ? { when: 'success' } : {}) },
        ...(opts.errorPlace ? [{ to: 'err', from: '@response', when: 'error' }] : []),
      ]);
  return {
    id: opts.id,
    kind: 'http',
    label: opts.label ?? opts.id,
    ...schedule(opts),
    presets: {
      input: preset(
        opts.inputPlace,
        opts.host,
        opts.scheduleCron || opts.intervalMs ? { consume: false, optional: true } : {},
      ),
    },
    postsets,
    action,
    emit,
    mode: opts.mode ?? 'SINGLE',
  };
}

/**
 * Consumes COMMAND-SHAPED tokens (kind/id/executor/command/args) and emits @result.
 * Scheduled command transitions (watchers/sentinels) re-read a persistent config
 * token each tick instead of consuming it — the staging sentinel pattern.
 */
export function buildCommandInscription(opts: BuildOpts) {
  return {
    id: opts.id,
    kind: 'command',
    label: opts.label ?? opts.id,
    ...schedule(opts),
    presets: {
      input: preset(opts.inputPlace, opts.host, opts.scheduleCron || opts.intervalMs ? { consume: false, optional: true } : {}),
    },
    postsets: { log: { placeId: opts.outputPlace, host: opts.host, ...(opts.capacity ? { capacity: opts.capacity } : {}) } },
    action: {
      type: 'command',
      inputPlace: 'input',
      ...(opts.executorId ? { executorId: opts.executorId } : {}),
      groupBy: 'executor',
      dispatch: [{ executor: 'bash', channel: 'default' }],
      await: 'ALL',
      timeoutMs: opts.timeoutMs ?? 150000,
    },
    emit: [{ to: 'log', from: '@result' }],
    mode: opts.mode ?? 'SINGLE',
  };
}

/**
 * Autonomous multi-step AGENT persona — the shape the safe-team personas use
 * (t-dev-plan etc.). `role` is the positional rwxhludcts capability string (rw-- = reason+write;
 * rwxhl---t adds execute/http/logs + t for tool-net invocation — INVOKE_TOOL_NET is gated by
 * the t flag, not x). `action.modelId` is the net
 * model; `tier` selects the LLM (default = worker, "high" = the thinking model).
 * autoEmit:true routes the agent's final result to the single postset — a
 * self-driving worker: STARTED, it watches its input place and processes each
 * task token that lands there, in parallel with everything else running.
 */
export function buildAgentInscription(opts: BuildOpts) {
  return {
    id: opts.id,
    kind: 'agent',
    label: opts.label ?? opts.id,
    ...(opts.description ? { description: opts.description } : {}),
    // Root-level copy kept for human readers/back-compat, but the master reads the role
    // EXCLUSIVELY from action.role (AgentExecutionRequest.getRole()) — a root-only role is
    // silently ignored and the agent runs as the rw-- default. Field report §13: every
    // spawn_persona capability:"execute" worker was secretly running without x/h/l until this.
    role: opts.role ?? 'rw--',
    ...schedule(opts),
    presets: {
      input: preset(opts.inputPlace, opts.host, opts.scheduleCron || opts.intervalMs ? { consume: false, optional: true } : {}),
    },
    postsets: postset(opts),
    action: {
      type: 'agent',
      role: opts.role ?? 'rw--',
      modelId: opts.netModel ?? opts.host.split('@')[0],
      maxIterations: opts.maxIterations ?? 12,
      autoEmit: opts.autoEmit ?? true,
      nl:
        opts.nl ??
        opts.prompt ??
        'Process the bound input token and produce a concise, self-contained result token. Input: ${input.data}',
      ...(opts.tier ? { tier: opts.tier } : {}),
      timeoutMs: opts.timeoutMs ?? 240000,
    },
    mode: opts.mode ?? 'SINGLE',
  };
}

export function buildInscription(kind: string, opts: BuildOpts): Record<string, any> {
  switch (kind) {
    case 'link':
      return buildLinkInscription(
        opts.id, opts.label ?? '', opts.inputPlace, opts.outputPlace, opts.host, opts.relation);
    case 'map':
      return buildMapInscription(opts);
    case 'llm':
      return buildLlmInscription(opts);
    case 'http':
      return buildHttpInscription(opts);
    case 'command':
      return buildCommandInscription(opts);
    case 'agent':
      return buildAgentInscription(opts);
    default:
      throw new Error(`Unsupported transition kind '${kind}' (supported: link, map, llm, http, command, agent)`);
  }
}

/** Which agent executes a given kind. */
export function agentFor(kind: string): string {
  return kind === 'command' ? 'agentic-net-executor-default' : 'agentic-net-master';
}

/**
 * Persist the inscription as a leaf under the DESIGNTIME pnml transition node so
 * the GUI renders it (delete-then-create: updateProperty 400s on these leaves).
 * No-op when the transition isn't part of the net's PNML.
 */
export async function persistInscriptionLeaf(
  ctx: AppContext,
  modelId: string,
  netId: string,
  transitionId: string,
  inscription: Record<string, any>,
): Promise<boolean> {
  const base = `root/workspace/sessions/${ctx.config.session}/workspace-nets/${netId}/pnml/net/transitions`;
  const nodes = await ctx.node.getChildren(modelId, base).catch(() => []);
  const tn = (nodes ?? []).find((c: any) => c.name === transitionId);
  if (!tn?.id) return false;
  const kids = await ctx.node.getChildren(modelId, `${base}/${transitionId}`).catch(() => []);
  const old = (kids ?? []).find((c: any) => c.name === 'inscription');
  const events: any[] = [];
  if (old?.id) {
    events.push({ eventType: 'deleteLeaf', parentId: tn.id, id: old.id, name: 'inscription' });
  }
  events.push({
    eventType: 'createLeaf',
    parentId: tn.id,
    id: 'auto',
    name: 'inscription',
    properties: { value: JSON.stringify(inscription) },
  });
  await ctx.node.executeEvents(modelId, events);
  return true;
}

/**
 * Assign (or re-assign) a transition on master. Note the engine gotcha:
 * assign STOPS a running transition — callers that want it live must start()
 * afterwards. Link transitions are assigned and NEVER started.
 */
export async function assignInscription(
  ctx: AppContext,
  modelId: string,
  inscription: Record<string, any>,
  agentId: string,
  credentials: Record<string, string> = {},
): Promise<void> {
  await ctx.master.assignTransition({
    modelId,
    transitionId: inscription.id,
    agentId,
    inscription,
    credentials,
  });
}
