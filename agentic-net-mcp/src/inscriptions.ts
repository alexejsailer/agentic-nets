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
  /** Required for link/agent/command; optional for map/llm/http WHEN routes cover the output. */
  outputPlace?: string;
  /** ArcQL WHERE condition filtering which input tokens bind (e.g. `$.verarbeitet == null`).
   *  The ONLY way to express a filtered preset on this surface — without it, mark-and-requeue
   *  designs self-loop because the preset rebinds whatever the lane emits back. */
  filter?: string;
  /** 6-field cron or interval ms — either arms a schedule. */
  scheduleCron?: string;
  intervalMs?: number;
  /** IANA timezone for cron schedules (e.g. Europe/Berlin). Unset = server zone. */
  timezone?: string;
  /**
   * What a SCHEDULED lane does when its input place is empty at tick time. Ignored without a schedule.
   *
   * - `fire` (default, and what scheduling has always done here): the preset becomes
   *   `consume:false, optional:true`, so the lane ticks whether or not a token is there and never
   *   consumes. This is the sentinel/heartbeat shape (see the `watcher` template). Beware: if the
   *   action interpolates `${input.*}`, every tick on an empty place emits a token with those fields
   *   silently missing, marked `_status:"success"`, and they accumulate forever.
   * - `skip`: the preset stays required and consuming, so the schedule is an AND-gate with token
   *   availability — the lane drains a queue on a timer and stays quiet when there is nothing to do.
   */
  onEmpty?: 'fire' | 'skip';
  timeoutMs?: number;
  /** Execution mode: SINGLE (bind all presets, fire once) or FOREACH (process each bound token
   *  independently with bounded per-fire fan-out). Default SINGLE. */
  mode?: 'SINGLE' | 'FOREACH';
  /** FOREACH tokens bound per firing. Default 1. */
  batchSize?: number;
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
  /** agent reasoning backend: api = master's configured provider; bash = headless CLI session. */
  llmMode?: 'api' | 'bash';
  /** agent bash backend (default claude when llmMode=bash). */
  binary?: 'claude' | 'codex';
  /** agent — external MCP servers the agent may call via MCP_CALL (requires the m role flag,
   *  e.g. role:"rwxh------m"). Entries {name, url, auth?: {type?, credentialKey, header?, scheme?},
   *  allowTools?, timeoutMs?}; auth ONLY via credentialKey + set_transition_credentials. */
  mcp?: Array<Record<string, any>>;
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
    return {
      schedule: {
        type: 'cron',
        cron: opts.scheduleCron,
        ...(opts.timezone ? { timezone: opts.timezone } : {}),
      },
    };
  }
  if (opts.intervalMs) return { schedule: { type: 'interval', intervalMs: opts.intervalMs } };
  return {};
}

/**
 * Light validation for the `filter` param — a WHERE condition, not a full query. Full ArcQL
 * grammar checking stays server-side; this catches the two real-world mistakes (pasting a whole
 * query, forgetting the `$.` path prefix) before an inscription is written.
 */
export function validateFilter(filter: string): void {
  const f = filter.trim();
  if (!f) throw new Error('filter must be a non-empty ArcQL condition');
  if (/^\s*FROM\b/i.test(f) || /\b(LIMIT|ORDER\s+BY)\b/i.test(f)) {
    throw new Error(
      `filter is a WHERE condition only (e.g. '$.status == "open"'), not a full query — ` +
        `FROM/LIMIT/ORDER BY are added by the tool. Got: "${f}"`,
    );
  }
  if (!f.includes('$.')) {
    throw new Error(
      `filter must reference token fields with the $. prefix (e.g. '$.verarbeitet == null'). Got: "${f}"`,
    );
  }
}

function inputPreset(opts: BuildOpts): PresetSpec {
  const batch = opts.batchSize ?? 1;
  if (!Number.isInteger(batch) || batch < 1) {
    throw new Error('batchSize must be a positive integer');
  }
  if (opts.filter) validateFilter(opts.filter);
  const where = opts.filter ? ` WHERE ${opts.filter.trim()}` : '';
  const foreach = opts.mode === 'FOREACH' && batch > 1
    ? { arcql: `FROM $${where} LIMIT ${batch}`, take: 'ALL' as const }
    : where
      ? { arcql: `FROM $${where} LIMIT 1` }
      : {};
  return preset(opts.inputPlace, opts.host, { ...schedulePresetOverride(opts), ...foreach });
}

/**
 * A lane that emits back into its own input place with an unfiltered preset rebinds its own
 * output immediately — an infinite self-loop that spams every downstream place. Field finding
 * F8c: this was impossible to build SAFELY before `filter` existed; now it is impossible to
 * build UNSAFELY. Agent lanes are exempt (the want-token pattern legitimately writes to its
 * own input, and agents bind work explicitly rather than by preset rebind).
 */
function guardSelfLoop(opts: BuildOpts, kind: string): void {
  if (kind === 'agent' || kind === 'link' || opts.filter) return;
  const targets = [opts.outputPlace, opts.errorPlace, ...(opts.routes ?? []).map((r) => r.place)];
  if (targets.includes(opts.inputPlace)) {
    throw new Error(
      `transition '${opts.id}' emits into its own input place '${opts.inputPlace}' with an unfiltered ` +
        `preset — it would rebind its own output forever. Either pass filter (e.g. '$.processed == null') ` +
        `so re-emitted tokens carry a marker the preset excludes, or emit to a separate archive place.`,
    );
  }
}

/** The kinds whose output place may be replaced entirely by routes. */
function requireOutputPlace(opts: BuildOpts, kind: string): string {
  if (opts.outputPlace) return opts.outputPlace;
  throw new Error(`kind '${kind}' requires outputPlace`);
}

/**
 * The preset overrides a SCHEDULE implies — one definition, so every kind agrees and so
 * `set_schedule` can apply exactly the same rule to a transition built earlier.
 *
 * Arming a schedule quietly rewrites the input preset, which is a much bigger behaviour change than
 * "it now also runs on a timer": with `onEmpty:'fire'` the lane stops consuming and starts ticking on
 * an empty place. That was previously implicit, undocumented, and applied on one code path only.
 */
export function schedulePresetOverride(opts: Pick<BuildOpts, 'scheduleCron' | 'intervalMs' | 'onEmpty'>) {
  if (!opts.scheduleCron && !opts.intervalMs) return {};
  return (opts.onEmpty ?? 'fire') === 'skip' ? { consume: true, optional: false } : { consume: false, optional: true };
}

/**
 * Warn when a scheduled lane will tick on an empty place while its action interpolates `${input.*}`.
 *
 * That pair provably emits junk: the template resolves against nothing, the referenced keys are
 * dropped from the output entirely, and the result is still stamped `_status:"success"` — one such
 * token per tick, forever. Returned as advice rather than an error because a heartbeat lane that
 * happens to mention input in a comment is legitimate.
 */
export function scheduleEmptyFireWarning(opts: BuildOpts): string | null {
  if (!opts.scheduleCron && !opts.intervalMs) return null;
  if ((opts.onEmpty ?? 'fire') !== 'fire') return null;
  const usesInput = [opts.prompt, opts.nl, opts.url, JSON.stringify(opts.template ?? null), JSON.stringify(opts.body ?? null)]
    .filter(Boolean)
    .some((s) => /\$\{\s*input\./.test(String(s)));
  if (!usesInput) return null;
  return (
    `Scheduled lane '${opts.id}' fires even when '${opts.inputPlace}' is empty (onEmpty:"fire", the default) ` +
    `while its action interpolates \${input.*}. Every tick on an empty place emits a token with those fields ` +
    `missing, marked success, and they accumulate without bound. Pass onEmpty:"skip" to make the schedule ` +
    `an AND-gate with token availability.`
  );
}

function postset(opts: BuildOpts): Record<string, any> {
  if (!opts.outputPlace) return {};
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
 *
 * Field finding F3: when an outputPlace is declared AND no route targets it, the result ALSO
 * emits there unconditionally — a declared-and-reported output must never be silently dead.
 * Routes-only lanes simply omit outputPlace.
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
  if (opts.outputPlace && !opts.routes.some((r) => r.place === opts.outputPlace)) {
    // The out postset itself comes from postset(opts) in each builder; this is its emit rule.
    emit.push({ to: 'out', from });
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
  if (!routed) requireOutputPlace(opts, 'map');
  return {
    id: opts.id,
    kind: 'map',
    label: opts.label ?? opts.id,
    ...schedule(opts),
    presets: { input: inputPreset(opts) },
    postsets: { ...postset(opts), ...(routed?.postsets ?? {}) },
    action: { type: 'map', template: opts.template ?? { value: '${input.data}' } },
    emit: opts.emit ?? routed?.emit ?? [{ to: 'out', from: '@response' }],
    mode: opts.mode ?? 'SINGLE',
  };
}

/**
 * Pass ("task") — pure routing. No action at all: the engine forwards the INPUT token, so
 * `from` is `@input.data` rather than a computed `@response`, and the master's own checker
 * warns when a task carries action config.
 *
 * <p>This kind was reachable by the engine and by fire_once but not by the MCP builder, so a
 * routing-only lane could not be created through the tools at all — the one kind whose entire
 * job is the `when` semantics everything else depends on.</p>
 */
export function buildPassInscription(opts: BuildOpts) {
  const routed = routeSplit(opts, '@input.data');
  if (!routed) requireOutputPlace(opts, 'pass');
  return {
    id: opts.id,
    kind: 'task',
    label: opts.label ?? opts.id,
    ...schedule(opts),
    presets: { input: inputPreset(opts) },
    postsets: { ...postset(opts), ...(routed?.postsets ?? {}) },
    emit: opts.emit ?? routed?.emit ?? [{ to: 'out', from: '@input.data' }],
    mode: opts.mode ?? 'SINGLE',
  };
}

export function buildLlmInscription(opts: BuildOpts) {
  if (!opts.routes?.length) requireOutputPlace(opts, 'llm');
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
      input: inputPreset(opts),
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

/**
 * Validate the agent's `action.mcp` server declarations and REJECT inline secrets before
 * anything is written. The master ignores inline auth fields at runtime and CredentialScrubber
 * redacts them on publish — so an inline token would produce an artifact that installs and then
 * 401s with no clue. Throwing here (with the credentialKey recipe) turns that silent trap into
 * an immediate, actionable error at authoring time.
 */
export function sanitizeMcp(mcp: Array<Record<string, any>> | undefined): Array<Record<string, any>> | undefined {
  if (!mcp) return undefined;
  if (!Array.isArray(mcp)) {
    throw new Error('mcp must be an array of server declarations [{name, url, auth?, allowTools?, timeoutMs?}]');
  }
  const inlineSecretKeys = ['token', 'apikey', 'api_key', 'api-key', 'password', 'secret', 'bearer', 'authorization', 'value'];
  return mcp.map((server, i) => {
    if (!server || typeof server !== 'object') {
      throw new Error(`mcp[${i}] must be an object`);
    }
    if (!server.name || !server.url) {
      throw new Error(`mcp[${i}] needs both name and url`);
    }
    if (!/^https?:\/\//.test(String(server.url))) {
      throw new Error(`mcp[${i}] url must be http(s), got '${server.url}'`);
    }
    const auth = server.auth;
    if (auth) {
      if (!auth.credentialKey) {
        throw new Error(`mcp[${i}] ("${server.name}") auth needs credentialKey — store the secret with `
          + `set_transition_credentials {credentials: {KEY: value}} and reference it as auth.credentialKey:"KEY". `
          + 'Inline secrets are ignored at runtime and redacted on publish.');
      }
      const inline = Object.keys(auth).find(k => inlineSecretKeys.includes(k.toLowerCase()));
      if (inline) {
        throw new Error(`mcp[${i}] ("${server.name}") auth carries an inline secret field '${inline}' — remove it; `
          + 'only auth.credentialKey + set_transition_credentials is supported.');
      }
    }
    return server;
  });
}

/**
 * Widen an agent role so the agent is actually offered MCP_CALL.
 *
 * The engine's `m` is the 11th positional slot of `rwxhludctsm` and is deliberately excluded from
 * every short form and named role. Every accepted role string is a prefix-or-positional form over
 * that same flag order, so right-padding with '-' to ten slots and appending 'm' preserves the
 * exact capability set and adds nothing but MCP reach.
 */
export function withMcpFlag(role?: string | null): string {
  const base = (role ?? 'rw').trim().toLowerCase();
  if (base.length > 11) throw new Error(`role '${role}' is not a valid rwxhludctsm flag string`);
  if (base.length === 11) return `${base.slice(0, 10)}m`;
  return `${base.padEnd(10, '-')}m`;
}

/** True when the role string already carries MCP reach. */
export function hasMcpFlag(role?: string | null): boolean {
  const v = (role ?? '').trim().toLowerCase();
  return v.length === 11 && v.endsWith('m');
}

/**
 * Drop MCP reach from a role, leaving every other flag exactly as it was.
 *
 * The inverse of {@link withMcpFlag}, for when the last declared server is detached: with nothing
 * declared the flag grants nothing anyway (the declaration IS the allowlist), so keeping it is
 * pure residue that reads as "this agent can reach outside" on every surface that shows a role.
 */
export function withoutMcpFlag(role?: string | null): string | undefined {
  const v = (role ?? '').trim().toLowerCase();
  if (v.length !== 11) return role ?? undefined;
  return v.slice(0, 10);
}

/**
 * The effective role for an agent that declares `action.mcp`.
 *
 * Declaring servers without the m flag is the silent-failure shape: discovery runs, the prompt
 * lists the servers, and MCP_CALL is never in the agent's tool set — the lane looks healthy and
 * reaches nothing. Passing `mcp` IS the intent to use it, so the flag is granted rather than
 * demanded. The one case that stays an error is a stated contradiction: an explicit 11-slot role
 * whose last slot is '-' alongside a declaration, where guessing which half the author meant
 * would either break the lane or widen capability behind their back.
 */
export function resolveAgentRole(role: string | undefined, mcp: unknown): string | undefined {
  if (!Array.isArray(mcp) || mcp.length === 0) return role;
  const v = (role ?? '').trim().toLowerCase();
  if (v.length === 11 && !v.endsWith('m')) {
    throw new Error(
      `role '${role}' explicitly denies MCP (slot 11 is '-') but action.mcp declares `
        + `${mcp.length} server(s). Either drop the declaration or grant the flag: '${withMcpFlag(role)}'.`,
    );
  }
  return withMcpFlag(role);
}

export function buildHttpInscription(opts: BuildOpts) {
  if (!opts.routes?.length) requireOutputPlace(opts, 'http');
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
      input: inputPreset(opts),
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
      input: inputPreset(opts),
    },
    postsets: { log: { placeId: requireOutputPlace(opts, 'command'), host: opts.host, ...(opts.capacity ? { capacity: opts.capacity } : {}) } },
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
  requireOutputPlace(opts, 'agent');
  // Resolved once so the root-level copy and action.role can never disagree, and so a declared
  // MCP server always arrives with the flag that makes it reachable.
  const agentRole = resolveAgentRole(opts.role, opts.mcp) ?? 'rw--';
  return {
    id: opts.id,
    kind: 'agent',
    label: opts.label ?? opts.id,
    ...(opts.description ? { description: opts.description } : {}),
    // Root-level copy kept for human readers/back-compat, but the master reads the role
    // EXCLUSIVELY from action.role (AgentExecutionRequest.getRole()) — a root-only role is
    // silently ignored and the agent runs as the rw-- default. Field report §13: every
    // spawn_persona capability:"execute" worker was secretly running without x/h/l until this.
    role: agentRole,
    ...schedule(opts),
    presets: {
      input: inputPreset(opts),
    },
    postsets: postset(opts),
    action: {
      type: 'agent',
      role: agentRole,
      modelId: opts.netModel ?? opts.host.split('@')[0],
      maxIterations: opts.maxIterations ?? 12,
      autoEmit: opts.autoEmit ?? true,
      nl:
        opts.nl ??
        opts.prompt ??
        'Process the bound input token and produce a concise, self-contained result token. Input: ${input.data}',
      ...(opts.tier ? { tier: opts.tier } : {}),
      ...(opts.llmMode ? { llmMode: opts.llmMode } : {}),
      ...(opts.binary ? { binary: opts.binary } : {}),
      ...(opts.mcp ? { mcp: sanitizeMcp(opts.mcp) } : {}),
      timeoutMs: opts.timeoutMs ?? 240000,
    },
    mode: opts.mode ?? 'SINGLE',
  };
}

export function buildInscription(kind: string, opts: BuildOpts): Record<string, any> {
  guardSelfLoop(opts, kind);
  switch (kind) {
    case 'link':
      return buildLinkInscription(
        opts.id, opts.label ?? '', opts.inputPlace, requireOutputPlace(opts, 'link'), opts.host, opts.relation);
    case 'map':
      return buildMapInscription(opts);
    case 'pass':
      return buildPassInscription(opts);
    case 'llm':
      return buildLlmInscription(opts);
    case 'http':
      return buildHttpInscription(opts);
    case 'command':
      return buildCommandInscription(opts);
    case 'agent':
      return buildAgentInscription(opts);
    default:
      throw new Error(`Unsupported transition kind '${kind}' (supported: link, pass, map, llm, http, command, agent)`);
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
