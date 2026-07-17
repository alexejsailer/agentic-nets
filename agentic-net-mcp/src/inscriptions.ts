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

export function buildLinkInscription(id: string, label: string, from: string, to: string, host: string) {
  return {
    id,
    kind: 'link',
    label,
    presets: { from: preset(from, host, { consume: false, optional: true }) },
    postsets: { to: { placeId: to, host } },
  };
}

export function buildMapInscription(opts: BuildOpts) {
  return {
    id: opts.id,
    kind: 'map',
    label: opts.label ?? opts.id,
    ...schedule(opts),
    presets: { input: preset(opts.inputPlace, opts.host, opts.scheduleCron || opts.intervalMs ? { consume: false, optional: true } : {}) },
    postsets: postset(opts),
    action: { type: 'map', template: opts.template ?? { value: '${input.data}' } },
    emit: [{ to: 'out', from: '@response' }],
    mode: opts.mode ?? 'SINGLE',
  };
}

export function buildLlmInscription(opts: BuildOpts) {
  const postsets: Record<string, any> = postset(opts);
  if (opts.errorPlace) {
    postsets.err = { placeId: opts.errorPlace, host: opts.host };
  }
  // With an errorPlace, split success vs error so a failed llm call (bad prompt, provider
  // down, unparseable response) lands somewhere visible instead of being silently dropped —
  // master 2.28+ builds errorPayloads from the when:"error" emit rules on every failure path,
  // mirroring the http lane.
  const emit = opts.emit ?? [
    { to: 'out', from: '@response.raw', ...(opts.errorPlace ? { when: 'success' } : {}) },
    ...(opts.errorPlace ? [{ to: 'err', from: '@response', when: 'error' }] : []),
  ];
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
      timeoutMs: opts.timeoutMs ?? 240000,
    },
    emit,
    mode: opts.mode ?? 'SINGLE',
  };
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
    ...(opts.auth ? { auth: opts.auth } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    timeoutMs: opts.timeoutMs ?? 30000,
  };
  // Default emit routes the JSON body to the output; with an errorPlace, split success vs error
  // so a failed call lands somewhere visible instead of being silently dropped.
  const emit = opts.emit ?? [
    { to: 'out', from: '@response.json', ...(opts.errorPlace ? { when: 'success' } : {}) },
    ...(opts.errorPlace ? [{ to: 'err', from: '@response', when: 'error' }] : []),
  ];
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
      return buildLinkInscription(opts.id, opts.label ?? opts.id, opts.inputPlace, opts.outputPlace, opts.host);
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
