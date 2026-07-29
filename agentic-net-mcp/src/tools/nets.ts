/**
 * Net-building layer — kind-aware, pre-wired construction (the Forge lesson:
 * never make the client LLM hand-author fragile inscriptions).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import {
  agentFor,
  assignInscription,
  buildInscription,
  persistInscriptionLeaf,
  scheduleEmptyFireWarning,
  schedulePresetOverride,
  validateCron,
} from '../inscriptions.js';
import { createAllowlistStoreAt } from '../allowlist-store.js';
import { clampValues } from './observe.js';
import { TemplateExecutor } from '../templates/executor.js';
import { TEMPLATES } from '../templates/index.js';
import { grantModel } from '../scope.js';
import { ensurePlacesContainer } from '../tree.js';
import { fetchTokens, linkPlaces } from './memory.js';

/**
 * Which add_transition params each kind actually consumes. Anything outside
 * common + its kind's set would silently vanish into a default — an agent's
 * misconception must bounce at the boundary instead (protocol-hardening trap
 * #4: `tier` on the wrong kind once silently bought the EXPENSIVE model).
 */
const COMMON_TRANSITION_ARGS = new Set([
  'netId', 'transitionId', 'kind', 'inputPlace', 'outputPlace', 'label', 'x', 'y',
  // `onEmpty` rides with the schedule params: it only means anything on a scheduled lane, and it
  // applies to every firing kind, so it belongs here rather than in a per-kind set.
  'scheduleCron', 'intervalMs', 'onEmpty', 'timeoutMs', 'capacity', 'mode', 'start', 'model',
]);
const KIND_TRANSITION_ARGS: Record<string, Set<string>> = {
  map: new Set(['template', 'emit', 'routes']),
  llm: new Set(['prompt', 'llmModel', 'tier', 'emit', 'routes', 'errorPlace']),
  http: new Set(['url', 'method', 'headers', 'body', 'auth', 'retry', 'emit', 'routes', 'errorPlace']),
  command: new Set(['executorId']),
  agent: new Set(['prompt', 'role', 'tier', 'maxIterations', 'autoEmit']),
  // Links are pure structure and never fire — schedules/timeouts/capacity are meaningless on them.
  link: new Set(['relation']),
};
const LINK_ALLOWED = new Set(['netId', 'transitionId', 'kind', 'inputPlace', 'outputPlace', 'label', 'relation', 'x', 'y', 'start', 'model']);
const PARAM_HOMES: Record<string, string> = {
  template: 'map', url: 'http', method: 'http', headers: 'http', body: 'http', auth: 'http', retry: 'http',
  prompt: 'llm/agent', llmModel: 'llm', tier: 'llm/agent', role: 'agent', maxIterations: 'agent', autoEmit: 'agent',
  executorId: 'command', errorPlace: 'llm/http', routes: 'map/llm/http', emit: 'map/llm/http',
};

/** Throws (BEFORE any write) when a param does not apply to the chosen kind. */
export function validateKindArgs(kind: string, args: Record<string, any>): void {
  const allowed = kind === 'link' ? LINK_ALLOWED : new Set([...COMMON_TRANSITION_ARGS, ...(KIND_TRANSITION_ARGS[kind] ?? [])]);
  const ignored = Object.keys(args).filter((k) => args[k] !== undefined && !allowed.has(k));
  if (!ignored.length) return;
  const hints = ignored
    .map((k) => (PARAM_HOMES[k] ? `${k} (applies to kind ${PARAM_HOMES[k]})` : k))
    .join(', ');
  throw new Error(
    `param(s) not applicable to kind '${kind}': ${hints}. They would be silently ignored, so nothing was created — drop them or switch the kind.`,
  );
}

/**
 * `onEmpty` only means something on a lane that ticks on a timer. Accepting it without a schedule
 * would silently ignore it, which is the exact failure class {@link validateKindArgs} exists to
 * prevent, and it would read as "I chose the semantics" when nothing was chosen.
 */
export function validateScheduleArgs(args: Record<string, any>): void {
  if (args.onEmpty !== undefined && !args.scheduleCron && !args.intervalMs) {
    throw new Error(
      "onEmpty only applies to a SCHEDULED lane — it decides what happens on a tick when the input " +
        'place is empty. Add scheduleCron or intervalMs, or drop onEmpty (an unscheduled lane already ' +
        'fires only when its input has a token, and consumes it).',
    );
  }
}

/**
 * Compile a session's deterministic steps into one bash script — the replayable
 * artifact behind crystallize_session. Steps are shell strings, {command}, or
 * {method,url,headers,body} (compiled to curl). `set -e` makes the replay fail
 * fast, exactly like the original run.
 */
export function compileSteps(steps: any[]): { script: string; count: number } {
  const lines: string[] = ['set -e'];
  let n = 0;
  for (const s of steps ?? []) {
    if (typeof s === 'string') {
      lines.push(s);
      n++;
      continue;
    }
    if (s?.note) lines.push(`# ${String(s.note).replace(/\n/g, ' ')}`);
    if (s?.command) {
      lines.push(String(s.command));
      n++;
    } else if (s?.url) {
      const method = String(s.method ?? 'GET').toUpperCase();
      const hdrs = s.headers
        ? Object.entries(s.headers)
            .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
            .join(' ')
        : '';
      const body = s.body != null ? ` -d ${JSON.stringify(typeof s.body === 'string' ? s.body : JSON.stringify(s.body))}` : '';
      lines.push(`curl -sS -X ${method} ${hdrs} ${JSON.stringify(String(s.url))}${body}`.replace(/\s+/g, ' '));
      n++;
    }
  }
  return { script: lines.join('\n'), count: n };
}

/**
 * Ready-made persona archetypes for spawn_persona — the platform's "available
 * personas" (developer, reviewer, researcher, operator, universal assistant)
 * expressed as sensible capability/tier/instruction defaults. The specific
 * `role` and any explicit arg always override the preset.
 */
export const PERSONA_PRESETS: Record<
  string,
  { role: string; capability: 'reason' | 'execute'; tier?: 'worker' | 'high'; framing: string }
> = {
  developer: {
    role: 'Implement the requested code change in the target repository',
    capability: 'execute',
    tier: 'high',
    framing:
      'You are a careful software DEVELOPER. Make the SMALLEST correct change that satisfies the task; where it helps, run commands / tool-nets to check your work; report exactly what you changed. Do not touch version control unless explicitly told to.',
  },
  reviewer: {
    role: 'Critically review the provided work for correctness, risks, and gaps',
    capability: 'reason',
    tier: 'high',
    framing:
      'You are a rigorous REVIEWER. Judge the input for correctness, edge cases, security, and gaps; return concrete, actionable findings (not vague praise). State clearly whether it should ship.',
  },
  researcher: {
    role: 'Investigate the question and return a grounded summary',
    capability: 'execute',
    tier: 'high',
    framing:
      'You are a RESEARCHER. Investigate using available tools; distinguish what you verified from what you inferred; return a concise, grounded summary with the evidence you relied on.',
  },
  operator: {
    role: 'Inspect system state and take safe corrective action',
    capability: 'execute',
    tier: 'worker',
    framing:
      'You are an OPERATOR. Inspect the current state, take only SAFE corrective actions, and report precisely what you observed and did. When in doubt, describe the fix instead of applying it.',
  },
  assistant: {
    role: 'Understand the task and produce a helpful result',
    capability: 'reason',
    tier: 'worker',
    framing: 'You are a helpful universal ASSISTANT. Understand the task and produce a clear, concise, directly useful result.',
  },
};

export function registerNetTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const allowlist = createAllowlistStoreAt(config.allowlistPath, config.persistAllowlist);
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'deploy_template',
    {
      title: 'Deploy a starter template',
      description:
        `Deploy a pre-built net into a model. Templates: ${Object.keys(TEMPLATES).join(', ')}. ` +
        'working-memory = the second-brain setup (memory places + an always-on LLM distiller); ' +
        'dev-team = a token-free development pipeline where YOU (the connected agent) are the worker; ' +
        'brain = scheduled LLM ideation/consolidation; blank = an empty canvas. Idempotent — re-deploys skip existing elements and never duplicate seeds.',
      inputSchema: {
        template: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]),
        params: z.record(z.string()).optional().describe('Template parameters (see the agenticnets://templates resource)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'deploy_template', mutates: true }, async (model, args) => {
      const blueprint = TEMPLATES[args.template as keyof typeof TEMPLATES];
      if (!blueprint) throw new Error(`unknown template '${args.template}'`);
      return new TemplateExecutor(ctx, model).deploy(blueprint, args.params ?? {});
    }),
  );

  if (config.allowModelCreate) {
    server.registerTool(
      'create_model',
      {
        title: 'Create a NEW model',
        description:
          "Mint a brand-new model on the stack (node registers + persists it; master auto-discovers it within ~10s and starts polling its transitions). The new model joins this connection's allowlist immediately AND is remembered for future sessions, so a model you create — and any scheduled lane you arm in it — stays reachable and stoppable after you disconnect. Optionally deploy a starter template into it in the same call. Disable model creation with AGENTICOS_ALLOW_MODEL_CREATE=false; disable the remembering with AGENTICOS_PERSIST_ALLOWLIST=false.",
        inputSchema: {
          modelId: z.string().describe('New model id, e.g. "team-alpha" (lowercase letters, digits, dashes)'),
          persistAllowlist: z
            .boolean()
            .optional()
            .describe(
              'Remember this model id so future sessions can target it (default TRUE for a newly created model). For a model that ALREADY exists on the node this defaults to FALSE and must be asked for explicitly — see the tool result for why.',
            ),
          name: z.string().optional().describe('Display name (default: the modelId)'),
          description: z.string().optional(),
          template: z
            .enum(Object.keys(TEMPLATES) as [string, ...string[]])
            .optional()
            .describe('Deploy a starter template into the new model right away (e.g. working-memory)'),
          profile: z
            .enum(['standard', 'research', 'knowledge', 'development'])
            .optional()
            .describe('Model composition profile — provisions resident net-agents on top of the domain context (research: research-analyst; knowledge: context-curator + crystallizer; development: dev-crew + crystallizer). Routed through master; a partial provisioning returns an error with per-artifact detail (re-run with the same profile to complete — installs are idempotent).'),
        },
      },
      wrapTool(scope, config.mode, { name: 'create_model', mutates: true }, async (_model, args) => {
        const modelId = String(args.modelId).trim();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(modelId)) {
          throw new Error('modelId must be lowercase letters/digits/dashes (max 64, starting alphanumeric)');
        }
        // Existence is decided by the NODE, not this connection's allowlist. A model can sit in
        // AGENTICOS_MODELS yet not exist on the node — the old allowlist-only guard told the caller
        // to "target it directly", which then 404s on the first write. Check the node instead.
        const existingRes = await ctx.client.nodeApi('GET', '/admin/models').catch(() => null);
        const existingModels: any[] = Array.isArray(existingRes) ? existingRes : (existingRes?.models ?? []);
        if (existingModels.some((m: any) => (m.modelId ?? m.id) === modelId)) {
          grantModel(scope, modelId);
          // Persist only when explicitly requested for a pre-existing model, but do it before
          // optional profile/workspace recovery so a downstream failure cannot discard the grant.
          const persist = args.persistAllowlist === true ? allowlist.add(modelId) : null;
          let profileResult: any;
          if (args.profile) {
            // This is also the recovery path after create returned modelCreated:true with a
            // partially provisioned profile. Provisioning is idempotent.
            profileResult = await ctx.client.masterApi(
              'POST',
              `/admin/models/${encodeURIComponent(modelId)}/profile`,
              { profile: args.profile },
            );
          }
          await ensurePlacesContainer(ctx, modelId).catch(() => undefined);
          // Granting access to a model we did NOT create is a different act from remembering one we
          // did. The allowlist's job is to contain client/LLM mistakes and prompt injection, so a
          // caller that names an arbitrary pre-existing model should not be able to make that grant
          // outlive the session by accident — it has to be asked for.
          return {
            created: false,
            existed: true,
            allowed: true,
            persisted: persist?.persisted ?? false,
            ...(profileResult ? { modelProfile: profileResult } : {}),
            note:
              `model '${modelId}' already exists on the node — granted to this session; target it directly.` +
              (persist
                ? persist.persisted
                  ? ` Remembered for future sessions in ${persist.path}.`
                  : ` NOT remembered: ${persist.error}.`
                : ' This grant is session-scoped because the model was not created here — pass persistAllowlist:true to make it durable.'),
          };
        }
        let profileResult: any;
        try {
          if (args.profile) {
            // A profile composition needs the MASTER create path: it provisions the
            // domain context AND installs the resident net-agents. Master returns a
            // non-201 (with modelCreated:true) when provisioning is incomplete —
            // surface that honestly instead of a blanket success.
            const res: any = await ctx.client.masterApi('POST', '/admin/models', {
              modelId,
              name: args.name ?? modelId,
              description: args.description ?? `Created via MCP session '${config.session}'`,
              profile: args.profile,
            });
            profileResult = res?.modelProfile;
          } else {
            await ctx.client.nodeApi('POST', '/admin/models', {
              modelId,
              name: args.name ?? modelId,
              description: args.description ?? `Created via MCP session '${config.session}'`,
            });
          }
        } catch (err: any) {
          if (err?.status === 400) {
            throw new Error(`model '${modelId}' could not be created — it likely already exists (list_models to check)`);
          }
          // GatewayError carries the raw body string — a non-201 with modelCreated:true
          // means the model EXISTS but the profile composition is incomplete.
          if (args.profile && typeof err?.body === 'string' && err.body.includes('"modelCreated"')) {
            let parsed: any = {};
            try { parsed = JSON.parse(err.body); } catch { /* keep the raw message below */ }
            if (parsed?.modelCreated === true) {
              grantModel(scope, modelId);
              const persist = args.persistAllowlist === false ? null : allowlist.add(modelId);
              throw new Error(`model '${modelId}' was created but profile '${args.profile}' provisioning is `
                + `incomplete: ${JSON.stringify(parsed?.modelProfile?.artifacts ?? [])} — re-run `
                + `create_model with the same profile to complete it (installs are idempotent). `
                + (persist === null
                  ? 'The grant was not remembered because persistAllowlist:false.'
                  : persist.persisted
                    ? `The model grant was already remembered in ${persist.path}.`
                    : `The grant could not be remembered: ${persist.error}.`));
            }
          }
          throw err;
        }
        grantModel(scope, modelId);
        // Persist as soon as model creation is known to have succeeded. Workspace/template setup
        // may fail afterward, but that must not strand a running model outside future sessions.
        const persist = args.persistAllowlist === false ? null : allowlist.add(modelId);
        // Eagerly provision the workspace skeleton (root/workspace/places) so the
        // very first add_place / memory_write against the new model cannot 404 on
        // a missing parent container — the "new model happy path" gap.
        const provisioned = await ensurePlacesContainer(ctx, modelId)
          .then(() => true)
          .catch(() => false);
        let template: any;
        if (args.template) {
          const blueprint = TEMPLATES[args.template as keyof typeof TEMPLATES];
          template = await new TemplateExecutor(ctx, modelId).deploy(blueprint, {});
        }
        return {
          created: modelId,
          allowed: true,
          persisted: persist?.persisted ?? false,
          ...(persist?.persisted ? { allowlistPath: persist.path } : {}),
          workspaceProvisioned: provisioned,
          note:
            'Master auto-discovers active models within ~10s. ' +
            (persist === null
              ? 'NOT remembered (persistAllowlist:false) — this grant ends with the session; add the id to AGENTICOS_MODELS to reach it again.'
              : persist.persisted
                ? `Remembered in ${persist.path}, so future sessions can still inspect, retune and pause_model it. Prune by editing that file.`
                : `Could NOT be remembered (${persist.error}) — this grant ends with the session, so add the id to AGENTICOS_MODELS if you are arming scheduled work in it.`),
          ...(template ? { template } : {}),
          ...(profileResult ? { modelProfile: profileResult } : {}),
        };
      }),
    );
  }

  server.registerTool(
    'create_net',
    {
      title: 'Create a net',
      description: 'Create an empty designtime net in the MCP session (a canvas for add_place/add_transition).',
      inputSchema: {
        netId: z.string(),
        name: z.string().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'create_net', mutates: true }, async (model, args) => {
      try {
        await ctx.master.createNet({ modelId: model, sessionId: config.session, netId: args.netId, name: args.name ?? args.netId });
      } catch (err: any) {
        // An error after a successful mutation is the worst possible output: a
        // careless caller retries and double-creates, a careful one debugs a
        // non-problem. On a 5xx, verify server state before reporting failure.
        if (err?.name === 'GatewayError' && Number(err.status) >= 500) {
          const check = await ctx
            .executorFor(model)
            .execute('GET_NET_OVERVIEW', { netId: args.netId, sessionId: config.session })
            .catch(() => null);
          if (check?.success) {
            return {
              created: args.netId,
              session: config.session,
              note: `master answered ${err.status}, but the net verifiably exists — treated as created. Do NOT retry the create.`,
            };
          }
        }
        throw err;
      }
      return { created: args.netId, session: config.session };
    }),
  );

  server.registerTool(
    'add_place',
    {
      title: 'Add a place',
      description:
        'Add a place to a net (designtime, for the GUI) AND as a runtime token container (so transitions can bind it). The net must already exist — a netId typo used to silently vivify a NEW net and split your topology across two; pass createIfMissing:true if you really do want it created here.',
      inputSchema: {
        netId: z.string(),
        placeId: z.string().describe('Convention: p-<name>'),
        label: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        createIfMissing: z
          .boolean()
          .optional()
          .describe('Create the net when it does not exist (default false — an unknown netId is an error, because it is almost always a typo).'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'add_place', mutates: true }, async (model, args) => {
      // Referential integrity on netId. Auto-vivification made a single typo split a topology across
      // two nets with no warning: both are individually valid, nothing downstream complains, and you
      // find half your places missing from the net you thought you were building.
      if (!args.createIfMissing) {
        const known: any = await ctx
          .executorFor(model)
          .execute('LIST_SESSION_NETS', { sessionId: config.session })
          .catch(() => null);
        const netIds: string[] = (known?.data?.nets ?? known?.data ?? [])
          .map((n: any) => (typeof n === 'string' ? n : n?.netId ?? n?.name))
          .filter(Boolean);
        // Only enforce when we could actually read the net list — never block a write on a failed read.
        if (netIds.length && !netIds.includes(String(args.netId))) {
          throw new Error(
            `Net '${args.netId}' does not exist in model '${model}' (session '${config.session}'). ` +
              `Known nets: ${netIds.join(', ')}. Check the id for a typo, create it with create_net, ` +
              `or pass createIfMissing:true if you intend a new net here.`,
          );
        }
      }
      await ctx.master
        .createPlace(args.netId, {
          modelId: model,
          sessionId: config.session,
          placeId: args.placeId,
          label: args.label ?? args.placeId,
          x: args.x ?? 100,
          y: args.y ?? 100,
          tokens: 0,
        })
        .catch((err: any) => {
          if (err?.name !== 'GatewayError' || (err.status !== 409 && err.status !== 422)) throw err;
        });
      const res = await ctx.executorFor(model).execute('CREATE_RUNTIME_PLACE', { placeId: args.placeId });
      if (!res.success) {
        // Partial success: the designtime place exists but the runtime container does not.
        // Return both halves (don't throw) so the caller knows exactly which step failed —
        // add_place does two writes and either can fail independently.
        return { place: args.placeId, designtime: true, runtime: false, error: res.error ?? 'runtime place creation failed' };
      }
      return { place: args.placeId, designtime: true, runtime: true, ...(res.data ?? {}) };
    }),
  );

  server.registerTool(
    'add_transition',
    {
      title: 'Add a transition (pre-wired by kind)',
      description:
        'Add a transition with a known-good inscription for its kind. Kinds: map (template transform), llm (one AI call: prompt template, optional model override), http (API call), command (executes command-shaped tokens on the executor), agent (autonomous multi-step persona — positional rwxhludcts role gating, tier-selected LLM, watches its input place), link (pure structure edge, never fires). Wires input/output arcs, assigns, and starts it (unless kind=link or start:false).',
      inputSchema: {
        netId: z.string(),
        transitionId: z.string().describe('Convention: t-<name>'),
        kind: z.enum(['map', 'llm', 'http', 'command', 'agent', 'link']),
        inputPlace: z.string(),
        outputPlace: z.string(),
        label: z.string().optional(),
        relation: z.string().optional().describe('link: typed edge semantics (what TARGET is to SOURCE) — relates | contains | references | derives-from | supersedes | promotes-to | archives-to | ... (open vocabulary; label defaults from it)'),
        x: z.number().optional(),
        y: z.number().optional(),
        prompt: z.string().optional().describe('llm/agent: the instruction; ${input.data.field} interpolates token fields'),
        llmModel: z.string().optional().describe('llm: per-transition model override (e.g. glm-5.2:cloud)'),
        role: z.string().optional().describe('agent: positional rwxhludcts capability string (r read, w write, x execute, h http, l logs, u user-await, d docker, c coordinate-personas, t tool-nets, s scripts). Default rw--; rwxhl---t = commands + tool-net invocation (INVOKE_TOOL_NET needs t, not x) — see docs/tool-catalog'),
        tier: z.string().optional().describe('llm/agent: LLM tier — omit for the worker/base model, "high" for the thinking model (llm also accepts "low"/"medium"; unknown tiers fall back to the EXPENSIVE model, so stick to these)'),
        maxIterations: z.number().optional().describe('agent: max reasoning steps (default 12)'),
        autoEmit: z.boolean().optional().describe('agent: auto-route the final result to the output place (default true)'),
        url: z.string().optional().describe('http: target URL (default ${input.data.url}). ${...} interpolates token fields; wrap user input in ${urlencode(...)} for query params'),
        method: z.string().optional().describe('http: default GET'),
        headers: z.record(z.string()).optional().describe('http: request headers; values may use ${...} and ${credentials.KEY}'),
        body: z.any().optional().describe('http: request body for POST/PUT (object or ${...} template)'),
        auth: z.record(z.any()).optional().describe('http: auth block, e.g. {type:"bearer", credentialKey:"API_TOKEN"} — pair with set_transition_credentials'),
        retry: z.record(z.any()).optional().describe('http: retry policy passed through to HttpActionHandler'),
        emit: z.array(z.any()).optional().describe('http/map: override the default emit rules verbatim (advanced)'),
        errorPlace: z.string().optional().describe('http/llm: route errors to this place (adds an err postset + a when:"error" emit) so a failed call lands somewhere visible instead of being silently dropped'),
        routes: z.array(z.object({ place: z.string(), when: z.string() })).optional().describe('map/llm/http: verdict/branch routing — one output place per {place, when}. Each `when` is a condition on the RESULT data (e.g. "verdict == \'APPROVE\'"); conditions must be mutually exclusive and cover every value (NO catch-all — an unmatched value leaves the input unconsumed/visible). Builds a review or branch lane (e.g. p-approved / p-needs-work) without hand-writing an inscription'),
        template: z.record(z.any()).optional().describe('map: the output template object'),
        executorId: z.string().optional().describe("For kind 'command': which executor runs it (see list_executors). '*' = any executor. Omit = default executor. If several executors are ONLINE and the user didn't say, ask them."),
        scheduleCron: z.string().optional().describe('6-field cron — makes this a scheduled tick'),
        intervalMs: z.number().optional().describe('Alternative to cron: fixed interval'),
        onEmpty: z
          .enum(['fire', 'skip'])
          .optional()
          .describe(
            'SCHEDULED lanes only: what to do when the input place is empty at tick time. "fire" (default) makes the preset consume:false/optional:true — the lane ticks regardless and never consumes (the sentinel/heartbeat shape); if the action interpolates ${input.*} every empty tick emits a token with those fields missing, marked success, forever. "skip" keeps the preset required and consuming, so the schedule is an AND-gate with token availability (drain a queue on a timer).',
          ),
        timeoutMs: z.number().optional(),
        capacity: z.number().optional().describe('Output place capacity (backpressure)'),
        mode: z.enum(['SINGLE', 'FOREACH']).optional().describe('Execution mode. SINGLE (default) binds all presets and fires once; FOREACH processes each bound token independently (bounded parallel fan-out) — use for per-token work like enriching every item in a batch'),
        start: z.boolean().optional().describe('Default true (links are never started)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'add_transition', mutates: true }, async (model, args) => {
      validateKindArgs(String(args.kind), args);
      validateScheduleArgs(args);
      const host = ctx.hostFor(model);
      const dup = (err: any) => {
        if (err?.name !== 'GatewayError' || (err.status !== 409 && err.status !== 422)) throw err;
      };
      // Ensure both endpoint places exist as DESIGNTIME places before wiring arcs. createArc
      // returns 404 (NOT 409/422, so `dup` won't swallow it) when a source/target place is
      // absent from the net's designtime PNML — which happens whenever the caller made the
      // place a runtime-only container (CREATE_RUNTIME_PLACE / an emit target) instead of
      // add_place. Mirror add_place's two idempotent writes so add_transition honours its
      // "wires input/output arcs" contract regardless of how the places were created.
      const ensurePlace = async (placeId: string, y: number) => {
        await ctx.master
          .createPlace(args.netId, {
            modelId: model,
            sessionId: config.session,
            placeId,
            label: placeId,
            x: args.x ?? 200,
            y,
            tokens: 0,
          })
          .catch(dup);
        await ctx
          .executorFor(model)
          .execute('CREATE_RUNTIME_PLACE', { placeId })
          .catch(() => undefined);
      };
      await ensurePlace(args.inputPlace, (args.y ?? 100) - 60);
      await ensurePlace(args.outputPlace, (args.y ?? 100) + 60);
      // Branch targets (routes/errorPlace) are real emit postsets — they must exist as places too,
      // or the emitted verdict token has nowhere to land.
      const branchPlaces = [
        ...(Array.isArray(args.routes) ? args.routes.map((r: any) => r.place) : []),
        ...(args.errorPlace ? [args.errorPlace] : []),
      ].filter((p, i, a) => p && p !== args.outputPlace && p !== args.inputPlace && a.indexOf(p) === i);
      let branchY = (args.y ?? 100) + 120;
      for (const bp of branchPlaces) {
        await ensurePlace(bp, branchY);
        branchY += 60;
      }
      await ctx.master
        .createTransition(args.netId, {
          modelId: model,
          sessionId: config.session,
          transitionId: args.transitionId,
          label: args.label ?? args.transitionId,
          x: args.x ?? 200,
          y: args.y ?? 100,
        })
        .catch(dup);
      await ctx.master
        .createArc(args.netId, {
          modelId: model,
          sessionId: config.session,
          arcId: `a-${args.transitionId}-in`,
          sourceId: args.inputPlace,
          targetId: args.transitionId,
        })
        .catch(dup);
      await ctx.master
        .createArc(args.netId, {
          modelId: model,
          sessionId: config.session,
          arcId: `a-${args.transitionId}-out`,
          sourceId: args.transitionId,
          targetId: args.outputPlace,
        })
        .catch(dup);
      // Wire an output arc to each branch target so the routed net is visually complete.
      for (let bi = 0; bi < branchPlaces.length; bi++) {
        await ctx.master
          .createArc(args.netId, {
            modelId: model,
            sessionId: config.session,
            arcId: `a-${args.transitionId}-b${bi}`,
            sourceId: args.transitionId,
            targetId: branchPlaces[bi],
          })
          .catch(dup);
      }

      const inscription = buildInscription(args.kind, {
        id: args.transitionId,
        label: args.label,
        relation: args.relation,
        host,
        inputPlace: args.inputPlace,
        outputPlace: args.outputPlace,
        prompt: args.prompt,
        llmModel: args.llmModel,
        url: args.url,
        method: args.method,
        headers: args.headers,
        body: args.body,
        auth: args.auth,
        retry: args.retry,
        emit: args.emit,
        routes: args.routes,
        errorPlace: args.errorPlace,
        template: args.template,
        executorId: args.executorId,
        scheduleCron: args.scheduleCron,
        intervalMs: args.intervalMs,
        onEmpty: args.onEmpty,
        timeoutMs: args.timeoutMs,
        capacity: args.capacity,
        mode: args.mode,
        // agent
        netModel: model,
        role: args.role,
        nl: args.prompt,
        tier: args.tier,
        maxIterations: args.maxIterations,
        autoEmit: args.autoEmit,
      });
      // Execution-mode inheritance resolves net/session policy from inscription metadata.
      // Keep it on both runtime and designtime copies so re-deploys preserve the scope.
      inscription.metadata = {
        ...(inscription.metadata ?? {}),
        sessionId: config.session,
        netId: String(args.netId),
      };
      // A concrete executorId doubles as the assignedAgent; '*' keeps the default
      // assignment (master offers the work to every polling executor).
      const agentId = (args.kind === 'command' && args.executorId && args.executorId !== '*') ? args.executorId : agentFor(args.kind);
      await assignInscription(ctx, model, inscription, agentId);
      await persistInscriptionLeaf(ctx, model, args.netId, args.transitionId, inscription);

      let started = false;
      if (args.kind !== 'link' && args.start !== false) {
        const runtime: any = await ctx.client.masterApi(
          'GET',
          `/transitions/${encodeURIComponent(String(args.transitionId))}/status`,
          undefined,
          { modelId: model },
        );
        if (runtime?.status !== 'external') {
          await ctx.master.startTransition(args.transitionId, model);
          started = true;
        }
      }
      // Arming a schedule rewrites the input preset; say so in the response instead of leaving the
      // caller to discover it by reading the inscription back.
      const scheduled = Boolean(args.scheduleCron || args.intervalMs);
      const warning = scheduleEmptyFireWarning({
        id: String(args.transitionId),
        host,
        inputPlace: String(args.inputPlace),
        outputPlace: String(args.outputPlace),
        scheduleCron: args.scheduleCron,
        intervalMs: args.intervalMs,
        onEmpty: args.onEmpty,
        prompt: args.prompt,
        nl: args.prompt,
        url: args.url,
        template: args.template,
        body: args.body,
      });
      return {
        transition: args.transitionId,
        kind: args.kind,
        started,
        external: args.kind !== 'link' && args.start !== false && !started,
        ...(scheduled
          ? {
              presetSemantics: {
                onEmpty: args.onEmpty ?? 'fire',
                consume: (inscription as any)?.presets?.input?.consume ?? true,
                note:
                  (args.onEmpty ?? 'fire') === 'fire'
                    ? 'scheduled lane ticks even when the input place is empty and never consumes'
                    : 'scheduled lane only fires when its input place has a token, and consumes it',
              },
            }
          : {}),
        ...(warning ? { warning } : {}),
        inscription,
      };
    }),
  );

  server.registerTool(
    'set_transition_credentials',
    {
      title: 'Set transition credentials (vault-backed)',
      description:
        'Store per-transition secrets the SECURE way: held in the vault (or encrypted at rest) and injected at fire time — NEVER hardcoded into the inscription or a token (tokens are event-sourced and permanent). http/llm/map lanes: reference as {type:"bearer", credentialKey:"API_TOKEN"} in add_transition `auth`, or as ${credentials.API_TOKEN} inside a header/url/body. COMMAND lanes: the executor injects each secret as an ENVIRONMENT VARIABLE into the command — reference it in your command string as $API_TOKEN (a normal shell env var), so the secret never appears in the command text, argv, or any stored token. Replaces the full credential set for the transition; audit with list_transition_credentials, revoke with delete_transition_credentials.',
      inputSchema: {
        transitionId: z.string(),
        credentials: z
          .record(z.string())
          .describe('Key→secret map, e.g. { "API_TOKEN": "sk-..." }. Referenced in the inscription as ${credentials.API_TOKEN}.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'set_transition_credentials', mutates: true }, async (model, args) => {
      const keys = Object.keys(args.credentials ?? {});
      if (!keys.length) throw new Error('provide at least one credential key/value pair');
      await ctx.client.masterApi('POST', `/transitions/${args.transitionId}/credentials`, args.credentials, { modelId: model });
      // Never echo secret values back — only the key names.
      return {
        transition: args.transitionId,
        credentialKeys: keys,
        stored: true,
        note: 'http/llm: reference as ${credentials.<KEY>} (header/url/body/auth.credentialKey). command: reference as the shell env var $<KEY> — the executor injects it into the command environment, never the command text.',
      };
    }),
  );

  server.registerTool(
    'list_transition_credentials',
    {
      title: 'List transition credential keys (no values)',
      description:
        'Audit which secrets a transition holds WITHOUT revealing them: returns the credential KEY NAMES (never the values) and the storage backend (vault or legacy-encrypted). Use to confirm a lane authenticates the secure way, and to find lanes that embed a secret inline instead of using the vault. GET-based — readonly-safe.',
      inputSchema: { transitionId: z.string(), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'list_transition_credentials', mutates: false }, async (model, args) => {
      const res: any = await ctx.client.masterApi('GET', `/transitions/${args.transitionId}/credentials`, undefined, { modelId: model });
      const keys: string[] = res?.credentialKeys ?? [];
      return {
        transition: args.transitionId,
        credentialKeys: keys,
        hasCredentials: keys.length > 0,
        storage: res?.storage ?? 'unknown',
      };
    }),
  );

  server.registerTool(
    'delete_transition_credentials',
    {
      title: 'Delete (revoke) transition credentials',
      description:
        "Revoke a transition's stored secrets — removes the vault entry (or the legacy encrypted blob), completing the store → audit → revoke lifecycle. Requires master ≥ 2.32 for the DELETE route.",
      inputSchema: { transitionId: z.string(), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'delete_transition_credentials', mutates: true, destructive: true }, async (model, args) => {
      const res: any = await ctx.client.masterApi('DELETE', `/transitions/${args.transitionId}/credentials`, undefined, { modelId: model });
      return { transition: args.transitionId, deleted: res?.deleted ?? true, storage: res?.storage ?? 'unknown' };
    }),
  );

  server.registerTool(
    'set_schedule',
    {
      title: 'Set / change a transition schedule',
      description:
        'Merge a cron or interval schedule into an existing transition and restart it (assign stops a transition — this handles the restart). Pass `onEmpty` to also set the tick-on-empty semantics, the same knob add_transition exposes; omit it and the transition keeps whatever preset flags it already has (this tool does NOT silently rewrite them).',
      inputSchema: {
        transitionId: z.string(),
        scheduleCron: z.string().optional().describe('6-field cron'),
        intervalMs: z.number().optional(),
        onEmpty: z
          .enum(['fire', 'skip'])
          .optional()
          .describe(
            'What this scheduled lane does when its input place is empty. "fire" = preset becomes consume:false/optional:true (ticks regardless, never consumes — the heartbeat shape add_transition defaults to). "skip" = preset stays required and consuming (schedule AND-gated with token availability). Omit to leave the existing preset untouched.',
          ),
        netId: z.string().optional().describe('If given, the designtime inscription copy is updated too'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'set_schedule', mutates: true }, async (model, args) => {
      if (!args.scheduleCron && !args.intervalMs) throw new Error('provide scheduleCron or intervalMs');
      if (args.scheduleCron) validateCron(args.scheduleCron);
      const kids = await ctx.node.getChildren(model, `root/workspace/transitions/${args.transitionId}`);
      const leaf = (kids ?? []).find((c: any) => c.name === 'inscription');
      const value = leaf?.properties?.value ?? leaf?.value;
      if (!value) throw new Error(`no inscription found for ${args.transitionId}`);
      const inscription = JSON.parse(value);
      inscription.schedule = args.scheduleCron
        ? { type: 'cron', cron: args.scheduleCron }
        : { type: 'interval', intervalMs: args.intervalMs };
      // The two ways of arming a schedule used to disagree: add_transition rewrote the input preset to
      // consume:false/optional:true, set_schedule left it consuming and required. Same net, two
      // behaviours, chosen implicitly by which tool built it. `onEmpty` now names the choice on both;
      // omitting it here preserves the existing preset rather than mutating a working lane.
      if (args.onEmpty) {
        const override = schedulePresetOverride({
          scheduleCron: args.scheduleCron,
          intervalMs: args.intervalMs,
          onEmpty: args.onEmpty,
        });
        for (const preset of Object.values(inscription.presets ?? {})) {
          Object.assign(preset as Record<string, unknown>, override);
        }
      }
      const agentId = inscription.kind === 'command' ? 'agentic-net-executor-default' : 'agentic-net-master';
      await assignInscription(ctx, model, inscription, agentId);
      if (args.netId) await persistInscriptionLeaf(ctx, model, args.netId, args.transitionId, inscription);
      await ctx.master.startTransition(args.transitionId, model);
      const first: any = Object.values(inscription.presets ?? {})[0] ?? {};
      return {
        transition: args.transitionId,
        schedule: inscription.schedule,
        restarted: true,
        presetSemantics: {
          onEmpty: args.onEmpty ?? (first.optional === true ? 'fire' : 'skip'),
          consume: first.consume ?? true,
          ...(args.onEmpty ? {} : { note: 'existing preset flags left untouched — pass onEmpty to change them' }),
        },
      };
    }),
  );

  for (const [name, tool, description] of [
    ['fire_once', 'FIRE_ONCE', 'Fire a map/http/command/pass transition once (manual trigger). 409 while RUNNING — stop it first. NOT for llm/agent lanes: FIRE_ONCE is disabled for action.type=llm|agent — run those server-side by start_transition (master polls the model), or client-side via host_transition / EXECUTE_TRANSITION_SMART.'],
    ['start_transition', 'START_TRANSITION', 'Start a transition (begins polling its input places).'],
    ['stop_transition', 'STOP_TRANSITION', 'Stop a transition (kill switch for any lane).'],
  ] as const) {
    server.registerTool(
      name,
      {
        title: description.split('(')[0].trim(),
        description,
        inputSchema: {
          transitionId: z.string(),
          ...(name === 'fire_once'
            ? {
                maxResponseChars: z
                  .number()
                  .optional()
                  .describe(
                    'Cap on any single inlined response/body value (default 4000; 0 = uncapped). fire_once returns what the lane produced, so firing an http lane at a web page can otherwise dump the whole page into your context — one 81KB page is ~20k tokens. The token itself is stored in full either way; read it with query_tokens.',
                  ),
              }
            : {}),
          ...modelParam,
        },
      },
      wrapTool(scope, config.mode, { name, mutates: true }, async (model, args) => {
        // An unknown transition surfaces differently per lifecycle op (fire → empty 404,
        // start/stop → 500 with "Path segment … not found") — normalize all of them to
        // one actionable message instead of raw gateway noise.
        const notFound = (e: any) =>
          e?.name === 'GatewayError' &&
          (e.status === 404 || /not found|no such/i.test(String(e.body ?? e.message ?? '')));
        let res;
        try {
          res = await ctx.executorFor(model).execute(tool, { transitionId: args.transitionId });
        } catch (err: any) {
          if (notFound(err)) {
            throw new Error(
              `Transition '${args.transitionId}' not found in model '${model}'. Check the id with net_overview.`,
            );
          }
          throw err;
        }
        if (!res.success) {
          if (/not found|no such/i.test(res.error ?? '')) {
            throw new Error(
              `Transition '${args.transitionId}' not found in model '${model}'. Check the id with net_overview.`,
            );
          }
          throw new Error(res.error ?? `${tool} failed for '${args.transitionId}'`);
        }
        const payload = res.data ?? { ok: true };
        // fire_once returns whatever the lane produced, inline and unbounded. An http lane pointed
        // at a web page therefore spent the caller's context on the page — which pushed clients
        // away from the manual-trigger tool entirely, onto start_transition + place inspection,
        // inverting its whole ergonomic point. Cap it loudly here; the stored token keeps the full
        // value, so nothing is lost, only deferred to a deliberate read.
        if (name === 'fire_once') {
          const max = Number(args.maxResponseChars ?? 4000);
          const state = { truncated: false };
          const clamped = clampValues(payload, max, state);
          return state.truncated
            ? {
                ...clamped,
                truncated: true,
                note: `long values shortened to ${max} chars for this response only — the stored token is intact; read it with query_tokens, or re-fire with maxResponseChars:0`,
              }
            : clamped;
        }
        return payload;
      }),
    );
  }

  server.registerTool(
    'pause_model',
    {
      title: 'Pause the model (stop ALL running transitions)',
      description:
        'The model-wide kill switch: stops EVERY running transition, so nothing can fire — no LLM consumption, no schedules ticking, no commands executing — until you resume. Writes an audit record token (place p-mcp-control) capturing exactly what was running, so resume_model restores precisely that set. Use it before walking away, when a net misbehaves, or to freeze LLM spend instantly. Per-lane alternative: stop_transition.',
      inputSchema: { ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'pause_model', mutates: true }, async (model) => {
      const txRes = await ctx.client.masterApi('GET', '/runtime/transitions', undefined, { modelId: model });
      const txList: any[] = Array.isArray(txRes) ? txRes : (txRes?.transitions ?? txRes?.results ?? []);
      const running = txList
        .filter((t) => String(t.status ?? t.state ?? '').toUpperCase() === 'RUNNING')
        .map((t) => String(t.transitionId ?? t.id ?? t.name));
      const stopped: string[] = [];
      const failed: any[] = [];
      for (const tid of running) {
        try {
          await ctx.master.stopTransition(tid, model);
          stopped.push(tid);
        } catch (e: any) {
          failed.push({ transitionId: tid, error: String(e?.message ?? e).slice(0, 150) });
        }
      }
      // Audit record — the pause is itself a token with provenance, and the
      // resume contract: resume_model restarts exactly this set.
      const executor = ctx.executorFor(model);
      await executor.execute('CREATE_RUNTIME_PLACE', { placeId: 'p-mcp-control' }).catch(() => undefined);
      await executor
        .execute('CREATE_TOKEN', {
          placePath: 'root/workspace/places/p-mcp-control',
          data: { kind: 'pause-record', transitions: JSON.stringify(stopped), pausedAt: new Date().toISOString(), source: 'mcp' },
        })
        .catch(() => undefined);
      return {
        model,
        paused: true,
        stoppedCount: stopped.length,
        transitions: stopped,
        ...(failed.length ? { failed } : {}),
        note: 'Nothing fires until resume_model (restores this exact set) or start_transition (single lane).',
      };
    }),
  );

  server.registerTool(
    'resume_model',
    {
      title: 'Resume the model (restart the paused set)',
      description:
        'Undo pause_model: restarts exactly the transitions recorded by the most recent pause (or an explicit list you pass). Link transitions are never touched (they never run). Command lanes may take a few seconds to show RUNNING again (the executor re-registers on its next poll) — trust the resumedCount, or re-check net_stats after ~10s.',
      inputSchema: {
        transitions: z.array(z.string()).optional().describe('Explicit set to start (default: the latest pause-record from p-mcp-control)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'resume_model', mutates: true }, async (model, args) => {
      let list: string[] = args.transitions ?? [];
      if (!list.length) {
        const toks = await fetchTokens(ctx, model, 'p-mcp-control').catch(() => []);
        const recs = toks
          .map((t: any) => (t?.data && Object.keys(t.data).length ? t.data : (t?.properties ?? {})))
          .filter((d: any) => d.kind === 'pause-record');
        recs.sort((a: any, b: any) => String(b.pausedAt ?? '').localeCompare(String(a.pausedAt ?? '')));
        try {
          list = JSON.parse(recs[0]?.transitions ?? '[]');
        } catch {
          list = [];
        }
      }
      if (!list.length) throw new Error('nothing to resume: no pause-record in p-mcp-control and no explicit transitions given');
      const resumed: string[] = [];
      const failed: any[] = [];
      for (const tid of list) {
        try {
          await ctx.master.startTransition(tid, model);
          resumed.push(tid);
        } catch (e: any) {
          failed.push({ transitionId: tid, error: String(e?.message ?? e).slice(0, 150) });
        }
      }
      return { model, resumedCount: resumed.length, transitions: resumed, ...(failed.length ? { failed } : {}) };
    }),
  );

  server.registerTool(
    'create_persona',
    {
      title: 'Create a persona',
      description:
        'Create a net-native persona: a charter place holding its identity token, and optionally an LLM lane (inbox → llm transition → outbox) so the persona answers tokens autonomously. Without the lane, the persona is a role YOU play when working its places.',
      inputSchema: {
        name: z.string().describe('Short id, e.g. "scribe"'),
        role: z.string().describe('What this persona is responsible for'),
        withLlmLane: z.boolean().optional().describe('Default false (token-free persona)'),
        prompt: z.string().optional().describe('LLM lane instruction (default: act the charter role on ${input.data.text})'),
        llmModel: z.string().optional(),
        netId: z.string().optional().describe('Net for the designtime mirror (default persona-<name>)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'create_persona', mutates: true }, async (model, args) => {
      const id = String(args.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const netId = args.netId ?? `persona-${id}`;
      const executor = ctx.executorFor(model);
      const charter = `p-${id}-charter`;
      const created: string[] = [];

      await ctx.master
        .createNet({ modelId: model, sessionId: config.session, netId, name: `Persona ${args.name}` })
        .catch(() => undefined);
      for (const [placeId, x] of [[charter, 100]] as const) {
        await ctx.master
          .createPlace(netId, { modelId: model, sessionId: config.session, placeId, label: placeId, x, y: 100, tokens: 0 })
          .catch(() => undefined);
        const res = await executor.execute('CREATE_RUNTIME_PLACE', { placeId });
        if (!res.success) throw new Error(res.error ?? `place ${placeId} failed`);
        created.push(placeId);
      }
      const count = await ctx.node.getChildrenCount(model, `root/workspace/places/${charter}`).catch(() => 0);
      if (count === 0) {
        await executor.execute('CREATE_TOKEN', {
          placePath: `root/workspace/places/${charter}`,
          data: { persona: args.name, role: args.role, createdAt: new Date().toISOString(), source: 'mcp' },
        });
      }

      let lane: any;
      if (args.withLlmLane) {
        const inbox = `p-${id}-inbox`;
        const outbox = `p-${id}-outbox`;
        for (const [placeId, x] of [
          [inbox, 100],
          [outbox, 500],
        ] as const) {
          await ctx.master
            .createPlace(netId, { modelId: model, sessionId: config.session, placeId, label: placeId, x, y: 220, tokens: 0 })
            .catch(() => undefined);
          const res = await executor.execute('CREATE_RUNTIME_PLACE', { placeId });
          if (!res.success) throw new Error(res.error ?? `place ${placeId} failed`);
          created.push(placeId);
        }
        const tid = `t-${id}-respond`;
        await ctx.master
          .createTransition(netId, { modelId: model, sessionId: config.session, transitionId: tid, label: `${args.name} responds`, x: 300, y: 220 })
          .catch(() => undefined);
        await ctx.master
          .createArc(netId, { modelId: model, sessionId: config.session, arcId: `a-${tid}-in`, sourceId: inbox, targetId: tid })
          .catch(() => undefined);
        await ctx.master
          .createArc(netId, { modelId: model, sessionId: config.session, arcId: `a-${tid}-out`, sourceId: tid, targetId: outbox })
          .catch(() => undefined);
        const inscription = buildInscription('llm', {
          id: tid,
          label: `${args.name} responds`,
          host: ctx.hostFor(model),
          inputPlace: inbox,
          outputPlace: outbox,
          prompt:
            args.prompt ??
            `You are ${args.name} (${args.role}). Respond to this input from your role's perspective, concisely: \${input.data.text}`,
          llmModel: args.llmModel,
          capacity: 20,
        });
        await assignInscription(ctx, model, inscription, 'agentic-net-master');
        await persistInscriptionLeaf(ctx, model, netId, tid, inscription);
        await ctx.master.startTransition(tid, model);
        lane = { inbox, outbox, transition: tid, started: true };
      }
      // Charter is navigable from the memory graph
      await linkPlaces(ctx, model, charter, 'p-mem-knowledge', `${args.name} charter informs knowledge`).catch(() => undefined);
      return { persona: args.name, netId, charter, created, ...(lane ? { lane } : {}) };
    }),
  );

  server.registerTool(
    'spawn_persona',
    {
      title: 'Spawn an autonomous worker persona',
      description:
        'Stand up a COMPLETE self-driving persona net (like a safe-team developer): charter + task inbox + an agent-kind transition that watches the inbox and works each task autonomously (multi-step, tools, tier-selected LLM) + an output place. STARTED by default, so it runs server-side in parallel with everything else — spawn several and they work concurrently while you keep going here. Use a `preset` (developer | reviewer | researcher | operator | assistant) for a ready-made archetype, or give your own role. Feed it with memory_write place:"p-<name>-task" (or query_tokens/net_stats to watch it). capability:"execute" grants command/tool-net access (rwxhl---t — t gates tool-net invocation); default "reason" is rw-- (safe).',
      inputSchema: {
        name: z.string().describe('Short id, e.g. "dev" or "researcher"'),
        preset: z
          .enum(['developer', 'reviewer', 'researcher', 'operator', 'assistant'])
          .optional()
          .describe('Ready-made persona archetype — fills capability/tier/instruction (and a default role). Your own role/instruction/capability/tier override it.'),
        role: z.string().optional().describe('What this persona is responsible for (required unless a preset is given)'),
        instruction: z.string().optional().describe('Full agent instruction (nl). Default: a solid charter built from role + preset framing + capability.'),
        capability: z.enum(['reason', 'execute']).optional().describe('reason (rw--, default) or execute (rwxhl---t — may run commands / invoke tool-nets; t is the tool-net flag)'),
        tier: z.enum(['worker', 'high']).optional().describe('LLM tier: worker (default) or high (the thinking model)'),
        scheduleCron: z.string().optional().describe('6-field cron — makes the persona self-initiate periodically (default: reactive, fires when a task lands)'),
        intervalMs: z.number().optional().describe('Alternative to cron for a periodic persona'),
        maxIterations: z.number().optional().describe('Max reasoning steps per task (default 12)'),
        capacity: z.number().optional().describe('Output place capacity / backpressure (default 50)'),
        netId: z.string().optional().describe('Net id (default persona-<name>)'),
        start: z.boolean().optional().describe('Start the worker immediately (default true)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'spawn_persona', mutates: true }, async (model, args) => {
      const id = String(args.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const netId = args.netId ?? `persona-${id}`;
      const executor = ctx.executorFor(model);
      const host = ctx.hostFor(model);
      const preset = args.preset ? PERSONA_PRESETS[args.preset] : undefined;
      const responsibility = args.role ?? preset?.role;
      if (!responsibility) throw new Error('provide `role` (or a `preset` that supplies one)');
      const capability = args.capability ?? preset?.capability ?? 'reason';
      const tier = args.tier ?? preset?.tier; // 'worker' | 'high' | undefined
      // Master role string is positional rwxhludcts. 'execute' grants read/write/execute/http/logs
      // AND t (tooling): the persona's instruction tells it to DESCRIBE/INVOKE_TOOL_NET, which the
      // master gates behind t — the previous 'rwxhl' silently withheld exactly the tools the
      // instruction promised (tool-net invocation was a no-op grant).
      const roleFlags = capability === 'execute' ? 'rwxhl---t' : 'rw--';
      const charter = `p-${id}-charter`;
      const task = `p-${id}-task`;
      const output = `p-${id}-output`;
      const workTid = `t-${id}-work`;
      const created: string[] = [];

      await ctx.master
        .createNet({ modelId: model, sessionId: config.session, netId, name: `Persona ${args.name}` })
        .catch(() => undefined);

      for (const [placeId, x, y] of [
        [charter, 100, 100],
        [task, 100, 260],
        [output, 520, 260],
      ] as const) {
        await ctx.master
          .createPlace(netId, { modelId: model, sessionId: config.session, placeId, label: placeId, x, y, tokens: 0 })
          .catch(() => undefined);
        const res = await executor.execute('CREATE_RUNTIME_PLACE', { placeId });
        if (!res.success) throw new Error(res.error ?? `place ${placeId} failed`);
        created.push(placeId);
      }

      // Identity token in the charter (idempotent).
      const charterCount = await ctx.node.getChildrenCount(model, `root/workspace/places/${charter}`).catch(() => 0);
      if (charterCount === 0) {
        await executor.execute('CREATE_TOKEN', {
          placePath: `root/workspace/places/${charter}`,
          data: {
            persona: args.name,
            role: responsibility,
            capability,
            tier: tier ?? 'worker',
            ...(args.preset ? { preset: args.preset } : {}),
            createdAt: new Date().toISOString(),
            source: 'mcp',
          },
        });
      }

      const nl =
        args.instruction ??
        `You are the "${args.name}" persona. Your responsibility: ${responsibility}.\n\n` +
          (preset ? preset.framing + '\n\n' : '') +
          `A task token has landed in your inbox. Read it (the bound input is \${input.data}), do the work using your reasoning` +
          (capability === 'execute'
            ? ` and — where it helps — real tools: you MAY run commands and DESCRIBE_TOOL_NET / INVOKE_TOOL_NET (session "tools", same model) to ground your work; never let a tool error block you (fail open).`
            : `.`) +
          `\n\nProduce ONE concise, self-contained result token that captures your output and a short rationale. If the task is unclear or blocked, still emit a result token that states exactly what is missing. Work until the task is complete, then finish.`;

      const workTransition = { modelId: model, sessionId: config.session, transitionId: workTid, label: `${args.name} works`, x: 300, y: 260 };
      await ctx.master.createTransition(netId, workTransition).catch(() => undefined);
      await ctx.master
        .createArc(netId, { modelId: model, sessionId: config.session, arcId: `a-${workTid}-in`, sourceId: task, targetId: workTid })
        .catch(() => undefined);
      await ctx.master
        .createArc(netId, { modelId: model, sessionId: config.session, arcId: `a-${workTid}-out`, sourceId: workTid, targetId: output })
        .catch(() => undefined);

      const inscription = buildInscription('agent', {
        id: workTid,
        label: `${args.name} works`,
        description: `Autonomous ${capability} persona: ${responsibility}`,
        host,
        inputPlace: task,
        outputPlace: output,
        netModel: model,
        role: roleFlags,
        nl,
        tier: tier === 'high' ? 'high' : undefined,
        maxIterations: args.maxIterations,
        capacity: args.capacity ?? 50,
        scheduleCron: args.scheduleCron,
        intervalMs: args.intervalMs,
      });
      await assignInscription(ctx, model, inscription, agentFor('agent'));
      await persistInscriptionLeaf(ctx, model, netId, workTid, inscription);

      let started = false;
      if (args.start !== false) {
        await ctx.master.startTransition(workTid, model);
        started = true;
      }
      // Charter is navigable from the memory graph.
      await linkPlaces(ctx, model, charter, 'p-mem-knowledge', `${args.name} charter informs knowledge`).catch(() => undefined);

      return {
        persona: args.name,
        netId,
        ...(args.preset ? { preset: args.preset } : {}),
        role: roleFlags,
        capability,
        tier: tier ?? 'worker',
        charter,
        taskPlace: task,
        outputPlace: output,
        transition: workTid,
        started,
        created,
        howToUse: {
          giveTask: `memory_write { place: "${task}", text: "<the task>" }  (or query_tokens/net_overview to inspect)`,
          readResults: `query_tokens { place: "${output}" }`,
          monitor: `net_stats  ·  event_trail { q: "${workTid}" }  ·  diagnose_transition { transitionId: "${workTid}" }`,
        },
      };
    }),
  );

  server.registerTool(
    'scaffold_tool_net',
    {
      title: 'Scaffold a reusable tool-net',
      description:
        'Crystallize a capability into a reusable, invocable tool-net (net + input/output places + trigger + manifest) in a tools-tagged session. With `transitionKind` (command/http/llm) the trigger is pre-wired invoke-green by construction — the tool is immediately callable with invoke_tool_net (command runs input.command on the executor; http calls input.url; llm answers input.prompt). Omit transitionKind only if you will wire the inscription yourself.',
      inputSchema: {
        name: z.string().describe("Short tool name, e.g. 'weather-fetch'"),
        transitionKind: z
          .enum(['command', 'http', 'llm'])
          .optional()
          .describe('Pre-wire an invoke-green pipeline for this kind (recommended). Input shape: command⇒{command}, http⇒{url}, llm⇒{prompt}'),
        description: z.string().optional().describe('One sentence: what the tool does'),
        tags: z.array(z.string()).optional().describe('Manifest tags'),
        inputSchema: z.record(z.any()).optional().describe('JSON Schema for the input token'),
        outputSchema: z.record(z.any()).optional().describe('JSON Schema for the output token'),
        toolSessionId: z.string().optional().describe("Target session (default 'tools', auto-created)"),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'scaffold_tool_net', mutates: true }, async (model, args) => {
      const { model: _m, ...params } = args;
      const res = await ctx.executorFor(model).execute('SCAFFOLD_TOOL_NET', {
        toolSessionId: args.toolSessionId ?? 'tools',
        ...params,
      });
      if (!res.success) throw new Error(res.error ?? 'SCAFFOLD_TOOL_NET failed');
      return res.data ?? { ok: true };
    }),
  );

  server.registerTool(
    'invoke_tool_net',
    {
      title: 'Invoke a tool-net',
      description:
        'Synchronously call an existing tool-net by id: writes an input token, fires the trigger, polls the correlated result, and returns its data — deterministic reuse at zero LLM cost. Discover available tool-nets via the agenticnets://{model}/tool-nets resource.',
      inputSchema: {
        netId: z.string().describe('Tool-net identifier'),
        input: z.record(z.any()).optional().describe("Input payload matching the tool-net's input schema"),
        sessionId: z.string().optional().describe(`Session holding the tool-net (default: ${config.session}, then 'tools')`),
        timeoutMs: z.number().optional().describe('Polling timeout (default 30000)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'invoke_tool_net', mutates: true }, async (model, args) => {
      // Honor the documented "default: <session>, then 'tools'" fallback: scaffold_tool_net
      // defaults tools into session 'tools', so a bare invoke must look there too when the
      // manifest isn't in the primary session. An explicit sessionId is used verbatim.
      const sessions = args.sessionId
        ? [args.sessionId]
        : [config.session, 'tools'].filter((s, i, a) => a.indexOf(s) === i);
      let lastErr = 'INVOKE_TOOL_NET failed';
      for (const sessionId of sessions) {
        const res = await ctx.executorFor(model).execute('INVOKE_TOOL_NET', {
          netId: args.netId,
          sessionId,
          ...(args.input ? { input: args.input } : {}),
          ...(args.timeoutMs != null ? { timeoutMs: args.timeoutMs } : {}),
        });
        // INVOKE_TOOL_NET double-wraps: transport res.success can be true while the
        // INNER payload is {success:false, error:"tool-manifest not found ..."} — so
        // "found the tool" means both are ok. Only then return; else fall through.
        const inner: any = res?.data;
        if (res.success && inner?.success !== false) return inner ?? { ok: true };
        lastErr = inner?.error ?? res.error ?? 'INVOKE_TOOL_NET failed';
        // Only try the next session when the tool-net simply isn't in this one.
        if (!/not found/i.test(lastErr)) break;
      }
      throw new Error(lastErr);
    }),
  );

  server.registerTool(
    'crystallize_session',
    {
      title: 'Crystallize this session into memory + a replayable tool-net',
      description:
        'Record what a session did — the summary/decisions AND the concrete deterministic steps (the API calls / commands) — into working memory, and (when steps are given) crystallize those steps into a reusable command tool-net you can replay later at zero LLM cost. Steps are shell strings, {command}, or {method,url,headers,body} (compiled to curl). Returns the memory record + the tool-net id and the exact invoke_tool_net input that replays it. This is "capture what we did so next time Claude just runs it and pings for the result".',
      inputSchema: {
        title: z.string().describe('Short name for this crystallized workflow'),
        summary: z.string().optional().describe('What was discussed / decided (prose)'),
        steps: z
          .array(z.any())
          .optional()
          .describe('Deterministic replay steps: shell strings, {command}, or {method,url,headers,body}'),
        tags: z.array(z.string()).optional(),
        bake: z.boolean().optional().describe('Build the replay tool-net from steps (default true when steps are given)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'crystallize_session', mutates: true }, async (model, args) => {
      const executor = ctx.executorFor(model);
      const decisions = 'p-mem-decisions';
      await executor.execute('CREATE_RUNTIME_PLACE', { placeId: decisions }).catch(() => undefined);
      const { script, count } = compileSteps(args.steps ?? []);
      const record = {
        kind: 'session-crystal',
        title: args.title,
        ...(args.summary ? { summary: args.summary } : {}),
        ...(args.steps ? { steps: JSON.stringify(args.steps) } : {}),
        ...(count ? { replayCommand: script } : {}),
        ...(args.tags?.length ? { tags: JSON.stringify(args.tags) } : {}),
        createdAt: new Date().toISOString(),
        source: 'mcp',
      };
      const rec = await executor.execute('CREATE_TOKEN', { placePath: `root/workspace/places/${decisions}`, data: record });
      if (!rec.success) throw new Error(rec.error ?? 'recording the session failed');

      let toolNet: any;
      if (count && args.bake !== false) {
        const slug =
          String(args.title)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'session';
        const res = await executor.execute('SCAFFOLD_TOOL_NET', {
          toolSessionId: 'tools',
          name: `session-${slug}`,
          transitionKind: 'command',
          description: `Deterministic replay of session "${args.title}" (${count} step${count === 1 ? '' : 's'})`,
          tags: ['session-crystal', ...(args.tags ?? [])],
        });
        toolNet = res.success
          ? {
              netId: res.data?.netId,
              replay: { netId: res.data?.netId, sessionId: 'tools', input: { command: script } },
              note: 'Replay deterministically (zero LLM): invoke_tool_net with the fields in `replay`.',
            }
          : { note: `tool-net scaffold failed: ${res.error}`, replayCommand: script };
      }

      return {
        crystallized: true,
        recordedTo: decisions,
        title: args.title,
        steps: count,
        ...(toolNet ? { toolNet } : count ? { replayCommand: script } : {}),
      };
    }),
  );
}
