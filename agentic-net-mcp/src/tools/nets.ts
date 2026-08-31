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
import { NetLayout, serpentineLayout, type NetElement, type NetArc } from '../layout.js';
import { clampValues, isLlmHealthReady } from './observe.js';
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
  'netId', 'transitionId', 'kind', 'inputPlace', 'outputPlace', 'filter', 'label', 'x', 'y',
  // A config/charter place bound NON-consuming. Applies to every firing kind: pointing
  // inputPlace at a brief consumes it, and the first fire deletes the net's configuration.
  'configPlace', 'configFilter',
  // `onEmpty` rides with the schedule params: it only means anything on a scheduled lane, and it
  // applies to every firing kind, so it belongs here rather than in a per-kind set.
  'scheduleCron', 'intervalMs', 'timezone', 'onEmpty', 'timeoutMs', 'capacity', 'mode', 'batchSize', 'start', 'replace', 'model',
]);
const KIND_TRANSITION_ARGS: Record<string, Set<string>> = {
  // pass is routing and nothing else: no action to configure, so emit/routes ARE its whole surface.
  pass: new Set(['emit', 'routes']),
  map: new Set(['template', 'emit', 'routes']),
  llm: new Set(['prompt', 'llmModel', 'group', 'tier', 'emit', 'routes', 'errorPlace']),
  http: new Set(['url', 'method', 'headers', 'body', 'auth', 'retry', 'emit', 'routes', 'errorPlace']),
  command: new Set(['executorId']),
  agent: new Set(['prompt', 'role', 'group', 'tier', 'maxIterations', 'autoEmit', 'llmMode', 'binary', 'mcp', 'capabilityProfile', 'llmModel']),
  // Links are pure structure and never fire — schedules/timeouts/capacity are meaningless on them.
  link: new Set(['relation']),
};
const LINK_ALLOWED = new Set(['netId', 'transitionId', 'kind', 'inputPlace', 'outputPlace', 'label', 'relation', 'x', 'y', 'start', 'model']);
const PARAM_HOMES: Record<string, string> = {
  template: 'map', url: 'http', method: 'http', headers: 'http', body: 'http', auth: 'http', retry: 'http',
  prompt: 'llm/agent', llmModel: 'llm', group: 'llm/agent', tier: 'llm/agent', role: 'agent', maxIterations: 'agent', autoEmit: 'agent',
  llmMode: 'agent', binary: 'agent with llmMode:"bash"', mcp: 'agent (needs the m role flag, e.g. role:"rwxh------m")',
  executorId: 'command', errorPlace: 'llm/http', routes: 'pass/map/llm/http', emit: 'pass/map/llm/http',
  filter: 'pass/map/llm/http/command/agent (not link — links never bind tokens)',
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

/** Prevent a backend choice that looks accepted but cannot affect execution. */
export function validateAgentBackendArgs(kind: string, args: Record<string, any>): void {
  if (kind !== 'agent') return;
  if (args.binary !== undefined && args.llmMode !== 'bash') {
    throw new Error('binary only applies to an agent with llmMode:"bash"; set llmMode or drop binary');
  }
}

/**
 * Read a net's current designtime geometry into a {@link NetLayout} plus the set of element ids
 * that already exist (with or without coordinates). Fails soft: an unreadable net behaves like an
 * empty one, so layout degrades to origin-anchored placement instead of blocking the write.
 */
async function loadNetLayout(
  ctx: AppContext,
  model: string,
  session: string,
  netId: string,
): Promise<{ layout: NetLayout; existing: Set<string> }> {
  const info: any = await ctx.master.getNet(netId, model, session).catch(() => null);
  const elements = [
    ...((info?.places ?? []) as any[]).map((p) => ({ id: String(p?.placeId ?? ''), x: p?.x, y: p?.y })),
    ...((info?.transitions ?? []) as any[]).map((t) => ({ id: String(t?.transitionId ?? ''), x: t?.x, y: t?.y })),
  ].filter((e) => e.id);
  return { layout: new NetLayout(elements), existing: new Set(elements.map((e) => e.id)) };
}

/**
 * `onEmpty` only means something on a lane that ticks on a timer. Accepting it without a schedule
 * would silently ignore it, which is the exact failure class {@link validateKindArgs} exists to
 * prevent, and it would read as "I chose the semantics" when nothing was chosen.
 */
export function validateScheduleArgs(args: Record<string, any>): void {
  if (args.scheduleCron && args.intervalMs) {
    throw new Error('scheduleCron and intervalMs are alternatives; provide only one');
  }
  if (args.onEmpty !== undefined && !args.scheduleCron && !args.intervalMs) {
    throw new Error(
      "onEmpty only applies to a SCHEDULED lane — it decides what happens on a tick when the input " +
        'place is empty. Add scheduleCron or intervalMs, or drop onEmpty (an unscheduled lane already ' +
        'fires only when its input has a token, and consumes it).',
    );
  }
  if (args.timezone !== undefined && !args.scheduleCron) {
    throw new Error('timezone only applies to scheduleCron; add a cron schedule or drop timezone');
  }
  if (args.batchSize !== undefined && args.mode !== 'FOREACH') {
    throw new Error('batchSize only applies to mode:"FOREACH"');
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
 * One external MCP server as declared in an agent's `action.mcp`. Shared by add_transition and
 * spawn_persona so both builders describe the shape identically — the engine parses one shape,
 * and a schema that drifts between two builders is a bug report waiting to happen.
 */
export const MCP_SERVER_SCHEMA = z.array(
  z.object({
    name: z.string().describe('Server name the agent uses in MCP_CALL'),
    url: z.string().describe('Streamable HTTP endpoint, e.g. http://127.0.0.1:8091/mcp'),
    auth: z
      .object({
        type: z.enum(['bearer', 'header']).optional().describe('bearer (default) sends "<scheme> <credential>" in the header; header sends the raw credential'),
        credentialKey: z.string().describe('Key into the transition credentials (set_transition_credentials) — NEVER an inline secret'),
        header: z.string().optional().describe('Header name (default Authorization for bearer; required for type header)'),
        scheme: z.string().optional().describe('bearer only: scheme prefix (default Bearer)'),
      })
      .optional(),
    allowTools: z.array(z.string()).optional().describe("Restrict which of the server's tools the agent may call (omit = all advertised)"),
    timeoutMs: z.number().positive().optional(),
  }),
);

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

/**
 * sync_net — reconcile the designtime canvas with runtime, deliberately as a STEP rather
 * than a side effect.
 *
 * The two layers are separate on purpose: PNML is what a human draws, inscriptions are what
 * the engine runs, and you can legitimately hold one without the other mid-build. Coupling
 * every runtime mutation to the canvas would erase that. What was missing is not automatic
 * coupling but a way to SEE the divergence and close it when the work is done — otherwise
 * the drift is invisible until something else trips over it (a reviewing agent reading a
 * shape that cannot fire, a pack exporting arcs to nothing).
 *
 * Reports by default; `apply:true` performs the removals.
 */
function registerSyncNet(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  if (config.mode === 'readonly') return;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'sync_net',
    {
      title: 'Reconcile canvas with runtime',
      description:
        'Compare a net\'s designtime canvas against its runtime transitions and report the drift: shapes with no runtime behind them (the canvas showing something that cannot fire), and arcs whose endpoints no longer exist. ' +
        'Runtime transitions with no shape are reported too, but never auto-drawn — placing an element means choosing coordinates, which is a layout decision, not a cleanup. ' +
        'Read-only by default; pass apply:true to remove the stale shapes and dangling arcs. Run it when a net is finished, or when the editor and net_stats disagree.',
      inputSchema: {
        netId: z.string(),
        sessionId: z.string().optional().describe('Defaults to this connection\'s session'),
        apply: z.boolean().optional().describe('Default false (report only). true removes stale shapes and dangling arcs.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'sync_net', mutates: true }, async (model, args) => {
      const exec = ctx.executorFor(model);
      const sessionId = args.sessionId ?? ctx.config.session;
      const run = async (tool: string, params: Record<string, unknown>) => {
        const res = await exec.execute(tool as any, params);
        if (!res.success) throw new Error(`${tool}: ${res.error ?? 'failed'}`);
        return res.data as any;
      };

      const pnml = await run('EXPORT_PNML', { netId: args.netId, sessionId, model });
      const net = pnml?.net ?? pnml;
      const shapes: Record<string, any> = net?.transitions ?? {};
      const places: Record<string, any> = net?.places ?? {};
      const arcs: Record<string, any> = net?.arcs ?? {};

      const listed = await run('LIST_ALL_INSCRIPTIONS', { limit: 500, model });
      const runtimeIds = new Set<string>(
        (listed?.transitions ?? []).map((t: any) => t.transitionId ?? t.id).filter(Boolean),
      );

      const elementIds = new Set([...Object.keys(places), ...Object.keys(shapes)]);
      const staleShapes = Object.keys(shapes).filter((t) => !runtimeIds.has(t));
      const danglingArcs = Object.entries(arcs)
        .filter(([, a]: [string, any]) => !elementIds.has(a?.source) || !elementIds.has(a?.target))
        .map(([id]) => id);
      // Reported, never auto-created: drawing it would mean inventing coordinates.
      const undrawn = [...runtimeIds].filter((t) => !(t in shapes));

      const drift = staleShapes.length + danglingArcs.length;
      if (!args.apply) {
        return {
          netId: args.netId, applied: false, inSync: drift === 0 && undrawn.length === 0,
          staleShapes, danglingArcs, runtimeWithoutShape: undrawn,
          summary: drift === 0
            ? (undrawn.length ? `${undrawn.length} runtime transition(s) have no shape — draw them with add_transition or accept the split` : 'canvas and runtime agree')
            : `${staleShapes.length} stale shape(s) and ${danglingArcs.length} dangling arc(s) — re-run with apply:true to remove them`,
        };
      }

      const removedArcs: string[] = [];
      const removedShapes: string[] = [];
      // Straight to the DESIGNTIME endpoints. The native DELETE_TRANSITION is the RUNTIME
      // delete — for a stale shape the runtime half is already gone, so it fails and cleans
      // nothing. These are the only calls that touch the canvas layer.
      const q = { modelId: model, sessionId };
      // Arcs first: removing a shape while an arc still points at it would briefly widen the
      // very inconsistency this is closing.
      for (const arcId of danglingArcs) {
        try {
          await ctx.client.masterApi('DELETE', `/designtime/nets/${args.netId}/arcs/${arcId}`, undefined, q);
          removedArcs.push(arcId);
        } catch { /* already gone is success for a cleanup */ }
      }
      for (const t of staleShapes) {
        try {
          await ctx.client.masterApi('DELETE', `/designtime/nets/${args.netId}/transitions/${t}`, undefined, q);
          removedShapes.push(t);
        } catch { /* ditto */ }
      }
      return {
        netId: args.netId, applied: true, removedShapes, removedArcs,
        runtimeWithoutShape: undrawn,
        summary: `removed ${removedShapes.length} stale shape(s) and ${removedArcs.length} dangling arc(s)`,
      };
    }),
  );
}

export function registerNetTools(server: McpServer, ctx: AppContext): void {
  registerSyncNet(server, ctx);
  const { scope, config } = ctx;
  const allowlist = createAllowlistStoreAt(config.allowlistPath, config.persistAllowlist);
  // The allowlist is MUTABLE at runtime (create_model / hub_install call grantModel), but a tool
  // description is baked at registration. That is why the enum went stale: a model created in this
  // session worked perfectly while every description still named only the models present at
  // connect time — reported as "dynamic model schemas are stale". The text now says it is a
  // snapshot and points at the live answer, and announceModelGranted() tells the client to
  // re-list so a refreshed description reaches it without a reconnect.
  const modelDescription = () =>
    `Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel}). `
    + 'Snapshot from connect time plus anything granted since; create_model/hub_install can add more '
    + 'mid-session — list_models is always the live answer.';
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(modelDescription()) }
    : {};

  /**
   * A newly granted model is usable immediately; this makes it VISIBLE too. Clients cache the tool
   * list, so without the notification the new model stays absent from every description until the
   * next reconnect — which is precisely how a working model looked unsupported.
   */
  const announceModelGranted = () => {
    try {
      server.sendToolListChanged();
    } catch {
      // A transport that cannot notify (or a client that never subscribed) is not a failure:
      // the grant already succeeded and list_models still reports the truth.
    }
  };

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
          announceModelGranted();
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
          announceModelGranted();
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
          announceModelGranted();
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
      description:
        'Create an empty designtime net in the MCP session (a canvas for add_place/add_transition). This is the preferred home for related durable stores: model their semantic relationships with directional typed kind=link transitions instead of leaving loose runtime places.',
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
        'Add a place to a net (designtime, for the GUI) AND as a runtime token container (so transitions can bind it). A related set should not remain disconnected: follow with typed kind=link transitions for semantic/context relationships, or firing transitions for executable flow. The net must already exist — a netId typo used to silently vivify a NEW net and split your topology across two; pass createIfMissing:true if you really do want it created here.',
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
      // Without explicit coords, take the next free grid slot instead of stacking every
      // place on (100,100) — and never reposition/relabel a place that already exists
      // (the designtime POST is an upsert, so a blind re-POST clobbers layout).
      const netLayout = await loadNetLayout(ctx, model, config.session, String(args.netId));
      if (!netLayout.existing.has(String(args.placeId))) {
        const slot = args.x != null && args.y != null
          ? { x: args.x, y: args.y }
          : netLayout.layout.nextSlot(String(args.placeId));
        await ctx.master
          .createPlace(args.netId, {
            modelId: model,
            sessionId: config.session,
            placeId: args.placeId,
            label: args.label ?? args.placeId,
            x: slot.x,
            y: slot.y,
            tokens: 0,
          })
          .catch((err: any) => {
            if (err?.name !== 'GatewayError' || (err.status !== 409 && err.status !== 422)) throw err;
          });
      }
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

  let addTransitionHandler!: ReturnType<typeof wrapTool>;
  const batchTransitionSchema = z.object({
    transitionId: z.string(),
    kind: z.enum(['pass', 'map', 'llm', 'http', 'command', 'agent', 'link']),
    inputPlace: z.string(),
    outputPlace: z.string().optional(),
    configPlace: z.string().optional(),
    configFilter: z.string().optional(),
    filter: z.string().optional(),
    label: z.string().optional(),
    relation: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    prompt: z.string().optional(),
    llmModel: z.string().optional(),
    capabilityProfile: z.string().optional(),
    group: z.string().optional(),
    role: z.string().optional(),
    tier: z.string().optional(),
    maxIterations: z.number().optional(),
    autoEmit: z.boolean().optional(),
    llmMode: z.enum(['api', 'bash']).optional(),
    binary: z.enum(['claude', 'codex']).optional(),
    mcp: z.array(z.record(z.any())).optional(),
    url: z.string().optional(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
    body: z.any().optional(),
    auth: z.record(z.any()).optional(),
    retry: z.record(z.any()).optional(),
    emit: z.array(z.any()).optional(),
    errorPlace: z.string().optional(),
    routes: z.array(z.object({ place: z.string(), when: z.string() })).optional(),
    template: z.record(z.any()).optional(),
    executorId: z.string().optional(),
    scheduleCron: z.string().optional(),
    intervalMs: z.number().positive().optional(),
    timezone: z.string().optional(),
    onEmpty: z.enum(['fire', 'skip']).optional(),
    timeoutMs: z.number().optional(),
    capacity: z.number().optional(),
    mode: z.enum(['SINGLE', 'FOREACH']).optional(),
    batchSize: z.number().int().min(1).max(100).optional(),
    start: z.boolean().optional(),
    replace: z.boolean().optional(),
  });

  server.registerTool(
    'add_transition',
    {
      title: 'Add a transition (pre-wired by kind)',
      description:
        'Add a transition with a known-good inscription for its kind. Kinds: pass (pure routing — forwards the input token, no action; use routes/emit when-conditions to split traffic), map (template transform), llm (one AI call), http (API call), command (command-shaped tokens on an executor, including one-shot headless CLI jobs), agent (autonomous multi-step persona; server provider by default or llmMode:"bash" + binary:"claude"|"codex" for an unattended Desktop Lite CLI session), link (directional typed semantic/context edge, never fires). Prefer link transitions whenever related places need durable meaning or navigable context; use relation to state what the target is to the source. Wires input/output arcs, assigns, and starts it (unless kind=link or start:false).',
      inputSchema: {
        netId: z.string(),
        transitionId: z.string().describe('Convention: t-<name>'),
        kind: z.enum(['pass', 'map', 'llm', 'http', 'command', 'agent', 'link']),
        inputPlace: z.string(),
        outputPlace: z.string().optional().describe('Where results land. Required for every kind EXCEPT map/llm/http with routes (a pure branch lane may omit it). If given alongside routes and no route targets it, every result is ALSO emitted there unconditionally (multi-place write)'),
        configPlace: z.string().optional().describe('Config/charter/brief place bound NON-CONSUMING as a second preset named `config` — read it as ${config.data.field} in templates and prompts. Use this instead of pointing inputPlace at a brief: the input preset CONSUMES, so the first fire would delete the configuration the net depends on. Bound required (not optional) on purpose — an optional preset that binds nothing interpolates null into the action instead of failing loudly'),
        configFilter: z.string().optional().describe('ArcQL WHERE selecting which config token binds, e.g. \'$.active == "true"\' when the place holds several briefs'),
        filter: z.string().optional().describe('ArcQL WHERE condition selecting which input tokens bind, e.g. \'$.status == "open"\' or \'$.verarbeitet == null\'. Use == null for "field absent". Without a filter the preset binds ANY token — required for mark-and-requeue designs (a lane emitting into its own input place must exclude its own output or it self-loops)'),
        label: z.string().optional(),
        relation: z.string().optional().describe('link: typed edge semantics (what TARGET is to SOURCE) — relates | contains | references | derives-from | supersedes | promotes-to | archives-to | ... (open vocabulary; label defaults from it)'),
        x: z.number().optional(),
        y: z.number().optional(),
        prompt: z.string().optional().describe('llm/agent: the instruction; ${input.data.field} interpolates token fields'),
        llmModel: z.string().optional().describe('llm/agent: per-transition model override (e.g. deepseek-v4-flash:cloud). An explicit model always beats tier'),
        capabilityProfile: z.string().optional().describe('agent: narrow the tool set below the role ceiling (e.g. "research-worker", "token-worker", "net-builder"). This is the biggest agent cost lever — a lane with no profile ships the full ~90-tool preamble on EVERY iteration; narrowing one measured lane went from 273k to 11k tokens per fire with the same output contract, and converged faster'),
        group: z.string().optional().describe('llm/agent: named server-side model group. The group chooses the provider and tier lineup; inspect valid names with llm_groups. An explicit llmModel still wins inside that group'),
        role: z.string().optional().describe('agent: positional rwxhludctsm capability string (r read, w write, x execute, h http, l logs, u user-await, d docker, c coordinate-personas, t tool-nets, s scripts, m external MCP servers). Default rw--; rwxhl---t = commands + tool-net invocation (INVOKE_TOOL_NET needs t, not x); the m slot is position 11 and pairs with the mcp param — see docs/tool-catalog'),
        tier: z.string().optional().describe('llm/agent: LLM tier — omit for the worker/base model, "high" for the thinking model (llm also accepts "low"/"medium"; unknown tiers fall back to the EXPENSIVE model, so stick to these)'),
        maxIterations: z.number().optional().describe('agent: max reasoning steps (default 12)'),
        autoEmit: z.boolean().optional().describe('agent: auto-route the final result to the output place (default true)'),
        llmMode: z.enum(['api', 'bash']).optional().describe('agent: api (default) uses the server LLM provider; bash keeps the full agent loop but calls a headless Claude Code/Codex session and works in Desktop Lite with no provider'),
        binary: z.enum(['claude', 'codex']).optional().describe('agent with llmMode:"bash": headless CLI to run (default claude)'),
        mcp: MCP_SERVER_SCHEMA.optional().describe('agent: external MCP servers the agent may call via MCP_CALL. The 11th role flag m is added automatically (declaring servers IS the intent to use them); an explicit 11-slot role denying it is rejected as a contradiction. Discovered tools are advertised in the agent prompt; an unreachable server degrades to UNAVAILABLE without failing fires. Auth ONLY via credentialKey + set_transition_credentials — or use attach_mcp_server on an existing lane, which stores the credential for you'),
        url: z.string().optional().describe('http: target URL (default ${input.data.url}). ${...} interpolates token fields; wrap user input in ${urlencode(...)} for query params'),
        method: z.string().optional().describe('http: default GET'),
        headers: z.record(z.string()).optional().describe('http: request headers; values may use ${...} and ${credentials.KEY}'),
        body: z.any().optional().describe('http: request body for POST/PUT (object or ${...} template)'),
        auth: z.record(z.any()).optional().describe('http: auth block, e.g. {type:"bearer", credentialKey:"API_TOKEN"} — pair with set_transition_credentials'),
        retry: z.record(z.any()).optional().describe('http: retry policy passed through to HttpActionHandler'),
        emit: z.array(z.any()).optional().describe('http/map: override the default emit rules verbatim (advanced)'),
        errorPlace: z.string().optional().describe('http/llm: route errors to this place (adds an err postset + a when:"error" emit) so a failed call lands somewhere visible instead of being silently dropped'),
        routes: z.array(z.object({ place: z.string(), when: z.string() })).optional().describe('map/llm/http: verdict/branch routing — one output place per {place, when}. Each `when` is a condition on the RESULT data (e.g. "verdict == \'APPROVE\'"), NOT the input token — ${input.*} paths never resolve in `when`; conditions must be mutually exclusive and cover every value (an unmatched value leaves the input unconsumed/visible). Omit outputPlace for a pure branch lane; keep it to ADDITIONALLY write every result there. Builds a review or branch lane (e.g. p-approved / p-needs-work) without hand-writing an inscription'),
        template: z.record(z.any()).optional().describe('map: the output template object'),
        executorId: z.string().optional().describe("For kind 'command': which executor runs it (see list_executors). '*' = any executor. Omit = default executor. If several executors are ONLINE and the user didn't say, ask them."),
        scheduleCron: z.string().optional().describe('6-field cron — makes this a scheduled tick'),
        intervalMs: z.number().positive().optional().describe('Alternative to cron: fixed interval'),
        timezone: z.string().optional().describe('Cron only: IANA zone id, e.g. Europe/Berlin; default = server zone'),
        onEmpty: z
          .enum(['fire', 'skip'])
          .optional()
          .describe(
            'SCHEDULED lanes only: what to do when the input place is empty at tick time. "fire" (default) makes the preset consume:false/optional:true — the lane ticks regardless and never consumes (the sentinel/heartbeat shape); if the action interpolates ${input.*} every empty tick emits a token with those fields missing, marked success, forever. "skip" keeps the preset required and consuming, so the schedule is an AND-gate with token availability (drain a queue on a timer).',
          ),
        timeoutMs: z.number().optional(),
        capacity: z.number().optional().describe('Output place capacity (backpressure)'),
        mode: z.enum(['SINGLE', 'FOREACH']).optional().describe('Execution mode. SINGLE (default) binds all presets and fires once; FOREACH processes each bound token independently with bounded per-fire fan-out — use for per-token work like enriching every item in a batch'),
        batchSize: z.number().int().min(1).max(100).optional().describe('FOREACH only: bind/process this many tokens per firing (default 1); the lane drains the place across repeated polls'),
        start: z.boolean().optional().describe('Default true for NEW lanes (links are never started). A REPLACED lane stays STOPPED unless start:true is explicit.'),
        replace: z.boolean().optional().describe('Required (true) to overwrite an EXISTING transitionId, and rejected when that id does NOT exist (a replace that creates is a contradiction, and a mistyped id would add a competing consumer on the same input place). This is the inscription-edit path; the response returns the previous inscription.'),
        ...modelParam,
      },
    },
    (addTransitionHandler = wrapTool(scope, config.mode, { name: 'add_transition', mutates: true }, async (model, args) => {
      validateKindArgs(String(args.kind), args);
      validateAgentBackendArgs(String(args.kind), args);
      validateScheduleArgs(args);
      const host = ctx.hostFor(model);
      const dup = (err: any) => {
        if (err?.name !== 'GatewayError' || (err.status !== 409 && err.status !== 422)) throw err;
      };
      // Field finding V2-3: a re-used transitionId silently REPLACED the existing lane — a typo'd
      // id destroyed an unrelated inscription with no signal, and the replaced lane came back
      // RUNNING against the changed-inscription-stays-STOPPED rule. Replacing is legitimate (it
      // is the inscription-edit path on this surface) but must be explicit and reversible-ish.
      const prior: any = await ctx.client
        .masterApi('GET', `/transitions/${encodeURIComponent(String(args.transitionId))}/status`, undefined, { modelId: model })
        .catch(() => null);
      const priorExists = prior != null && (prior.status != null || prior.state != null);
      if (priorExists && args.replace !== true) {
        throw new Error(
          `Transition '${args.transitionId}' already exists in model '${model}' (status ${prior.status ?? prior.state}). ` +
            `add_transition would REPLACE its inscription. Pass replace:true to overwrite deliberately ` +
            `(the previous inscription is returned so you can restore it), or pick a new id.`,
        );
      }
      // The mirror of the guard above, and the one that was missing: replace:true means
      // "overwrite the lane at this id". If nothing is there, the request contradicts itself and
      // the old behaviour quietly CREATED a transition instead — so a mistyped id under
      // replace:true produced a second lane on the same input place, i.e. two consumers racing
      // for the same tokens, which is exactly what the caller was trying to avoid.
      if (!priorExists && args.replace === true) {
        throw new Error(
          `replace:true was passed but no transition '${args.transitionId}' exists in model '${model}' — ` +
            `nothing to replace. Creating one here would silently add a lane (and a competing consumer ` +
            `on '${args.inputPlace}') under a flag that promised to overwrite. ` +
            `Check the id for a typo (list_transitions shows what exists), or drop replace to create it deliberately.`,
        );
      }
      let previousInscription: any;
      if (priorExists) {
        const prev: any = await ctx.executorFor(model)
          .execute('GET_TRANSITION', { transitionId: args.transitionId })
          .catch(() => null);
        previousInscription = prev?.data?.inscription ?? prev?.data ?? undefined;
        // The changed-inscription rule: stop before swapping, and stay stopped unless the caller
        // explicitly asked to start (the executor caches inscriptions, and a lane that returns
        // RUNNING with a changed inscription mid-flight is the trap the doc rule exists for).
        await ctx.master.stopTransition(String(args.transitionId), model).catch(() => undefined);
      }
      // Branch targets (routes/errorPlace) are real emit postsets — they must exist as places too,
      // or the emitted verdict token has nowhere to land.
      const branchPlaces = [
        ...(Array.isArray(args.routes) ? args.routes.map((r: any) => r.place) : []),
        ...(args.errorPlace ? [args.errorPlace] : []),
      ].filter((p, i, a) => p && p !== args.outputPlace && p !== args.inputPlace && a.indexOf(p) === i);
      // Read the net's current geometry once, then place ONLY the missing elements along the
      // spine (place → transition → place, 200/180px pitch). Elements that already exist are
      // never re-POSTed: the designtime POST is an upsert, so a blind re-create used to reset
      // a carefully positioned place back to the default column and its label to the place id.
      const netLayout = await loadNetLayout(ctx, model, config.session, String(args.netId));
      const plan = netLayout.layout.planTransition({
        transitionId: String(args.transitionId),
        inputPlace: String(args.inputPlace),
        outputPlace: args.outputPlace ? String(args.outputPlace) : undefined,
        branchPlaces,
        x: args.x,
        y: args.y,
      });
      // Ensure endpoint places exist as DESIGNTIME places before wiring arcs. createArc
      // returns 404 (NOT 409/422, so `dup` won't swallow it) when a source/target place is
      // absent from the net's designtime PNML — which happens whenever the caller made the
      // place a runtime-only container (CREATE_RUNTIME_PLACE / an emit target) instead of
      // add_place. Mirror add_place's two idempotent writes so add_transition honours its
      // "wires input/output arcs" contract regardless of how the places were created.
      const ensurePlace = async (placeId: string) => {
        if (!netLayout.existing.has(placeId)) {
          const p = plan.places.get(placeId) ?? netLayout.layout.nextSlot(placeId);
          await ctx.master
            .createPlace(args.netId, {
              modelId: model,
              sessionId: config.session,
              placeId,
              label: placeId,
              x: p.x,
              y: p.y,
              tokens: 0,
            })
            .catch(dup);
        }
        await ctx
          .executorFor(model)
          .execute('CREATE_RUNTIME_PLACE', { placeId })
          .catch(() => undefined);
      };
      await ensurePlace(args.inputPlace);
      if (args.outputPlace) await ensurePlace(args.outputPlace);
      for (const bp of branchPlaces) {
        await ensurePlace(bp);
      }
      if (!netLayout.existing.has(String(args.transitionId))) {
        await ctx.master
          .createTransition(args.netId, {
            modelId: model,
            sessionId: config.session,
            transitionId: args.transitionId,
            label: args.label ?? args.transitionId,
            x: plan.transition.x,
            y: plan.transition.y,
          })
          .catch(dup);
      }
      await ctx.master
        .createArc(args.netId, {
          modelId: model,
          sessionId: config.session,
          arcId: `a-${args.transitionId}-in`,
          sourceId: args.inputPlace,
          targetId: args.transitionId,
        })
        .catch(dup);
      if (args.outputPlace) {
        await ctx.master
          .createArc(args.netId, {
            modelId: model,
            sessionId: config.session,
            arcId: `a-${args.transitionId}-out`,
            sourceId: args.transitionId,
            targetId: args.outputPlace,
          })
          .catch(dup);
      }
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
        configPlace: args.configPlace,
        configFilter: args.configFilter,
        filter: args.filter,
        prompt: args.prompt,
        llmModel: args.llmModel,
        group: args.group,
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
        timezone: args.timezone,
        onEmpty: args.onEmpty,
        timeoutMs: args.timeoutMs,
        capacity: args.capacity,
        mode: args.mode,
        batchSize: args.batchSize,
        // agent
        netModel: model,
        role: args.role,
        nl: args.prompt,
        tier: args.tier,
        maxIterations: args.maxIterations,
        autoEmit: args.autoEmit,
        llmMode: args.llmMode,
        binary: args.binary,
        mcp: args.mcp,
        capabilityProfile: args.capabilityProfile,
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
      // A REPLACED lane stays STOPPED unless start:true is explicit (the changed-inscription
      // rule); a fresh lane keeps the start-by-default behavior.
      const wantStart = priorExists ? args.start === true : args.start !== false;
      if (args.kind !== 'link' && wantStart) {
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
        outputPlace: args.outputPlace ? String(args.outputPlace) : undefined,
        scheduleCron: args.scheduleCron,
        intervalMs: args.intervalMs,
        timezone: args.timezone,
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
        ...(priorExists
          ? {
              replaced: true,
              ...(previousInscription ? { previousInscription } : {}),
              ...(started
                ? {}
                : { note: 'replaced lane left STOPPED (a changed inscription must be verified before it runs) — start_transition when ready, or pass start:true on the replace' }),
            }
          : {}),
        external: args.kind !== 'link' && wantStart && !started,
        ...(scheduled || args.mode === 'FOREACH'
          ? {
              presetSemantics: {
                ...(scheduled ? { onEmpty: args.onEmpty ?? 'fire' } : {}),
                consume: (inscription as any)?.presets?.input?.consume ?? true,
                ...(scheduled
                  ? {
                      note:
                        (args.onEmpty ?? 'fire') === 'fire'
                          ? 'scheduled lane ticks even when the input place is empty and never consumes'
                          : 'scheduled lane only fires when its input place has a token, and consumes it',
                    }
                  : {}),
                ...(args.mode === 'FOREACH'
                  ? {
                      batchSize: args.batchSize ?? 1,
                      foreach: `FOREACH processes ${args.batchSize ?? 1} token(s) per firing; the lane drains the place across repeated polls`,
                    }
                  : {}),
              },
            }
          : {}),
        ...(warning ? { warning } : {}),
        inscription,
      };
    })),
  );


/**
 * Whole-net relayout: read the designtime structure, compute a serpentine grid from the arc
 * graph, and PUT only the elements whose position changes. The general demand behind it: a net
 * is not done when tokens flow — it is done when the editor shows it. Exported for reuse and
 * auto-run at the end of add_transitions.
 */
async function relayoutNet(
  ctx: AppContext,
  model: string,
  netId: string,
  sessionId: string,
  engine: 'auto' | 'llm' | 'grid' = 'grid',
): Promise<{ netId: string; sessionId: string; engine: string; moved: number; elements: number; note?: string }> {
  const res: any = await ctx.executorFor(model).execute('GET_NET_STRUCTURE', { netId, sessionId });
  if (res?.success === false) throw new Error(String(res.error ?? 'GET_NET_STRUCTURE failed'));
  const d: any = res?.data ?? res ?? {};
  const places: any[] = d.places ?? [];
  const transitions: any[] = d.transitions ?? [];
  const arcs: any[] = d.arcs ?? [];
  const elements: NetElement[] = [
    ...places.map((p) => ({ id: String(p.placeId ?? p.id), type: 'place' as const })),
    ...transitions.map((t) => ({ id: String(t.transitionId ?? t.id), type: 'transition' as const })),
  ];
  const placeIds = new Set(places.map((p) => String(p.placeId ?? p.id)));
  const graph: NetArc[] = arcs.map((a) => ({ source: String(a.sourceId), target: String(a.targetId) }));
  const current = new Map<string, { x: number; y: number }>();
  for (const el of [...places, ...transitions]) {
    const id = String(el.placeId ?? el.transitionId ?? el.id);
    if (Number.isFinite(el.x) && Number.isFinite(el.y)) current.set(id, { x: Number(el.x), y: Number(el.y) });
  }

  // Engine choice. The platform has a SEMANTIC layout engine (master POST /api/llm/layout): the
  // LLM sees ids, types, LABELS and edges of the concrete net, so it can group branches, expose
  // cycles and respect meaning in ways the deterministic grid cannot. It costs one provider call
  // and needs a healthy provider, so: explicit layout_net defaults to auto (LLM first, grid
  // fallback), while the add_transitions AUTO-run always passes 'grid' — no automated step spends
  // LLM quota without being asked.
  let moves: Map<string, { x: number; y: number }> | undefined;
  let used = 'grid';
  let note: string | undefined;
  if (engine !== 'grid') {
    try {
      const labelOf = new Map<string, string>();
      for (const p2 of places) labelOf.set(String(p2.placeId ?? p2.id), String(p2.label ?? ''));
      for (const t2 of transitions) labelOf.set(String(t2.transitionId ?? t2.id), String(t2.label ?? ''));
      const resp: any = await ctx.client.masterApi('POST', '/llm/layout', {
        nodes: elements.map((e) => ({ id: e.id, type: e.type, label: labelOf.get(e.id) ?? '' })),
        edges: graph.map((a) => ({ source: a.source, target: a.target })),
      });
      const positions: any[] = resp?.layout?.positions ?? [];
      const byId = new Map<string, { x: number; y: number }>();
      for (const pos of positions) {
        if (pos?.id != null && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
          byId.set(String(pos.id), { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)) });
        }
      }
      // The LLM layout is only trusted COMPLETE: a partial answer would scatter the missing
      // elements at stale positions, which is worse than the grid.
      if (resp?.success !== false && byId.size === elements.length) {
        moves = new Map([...byId].filter(([id, p2]) => {
          const cur = current.get(id);
          return !(cur && cur.x === p2.x && cur.y === p2.y);
        }));
        used = 'llm';
      } else {
        note = `llm layout unavailable or incomplete (${byId.size}/${elements.length} positions) — used the deterministic grid`;
      }
    } catch (e: any) {
      note = `llm layout failed (${String(e?.message ?? e).slice(0, 100)}) — used the deterministic grid`;
    }
    if (!moves && engine === 'llm') throw new Error(note ?? 'llm layout failed');
  }
  if (!moves) moves = serpentineLayout(elements, graph, current);

  for (const [id, p] of moves) {
    const kind = placeIds.has(id) ? 'places' : 'transitions';
    await ctx.client.masterApi(
      'PUT',
      `/designtime/nets/${encodeURIComponent(netId)}/${kind}/${encodeURIComponent(id)}`,
      { modelId: model, sessionId, x: p.x, y: p.y },
    );
  }
  return { netId, sessionId, engine: used, moved: moves.size, elements: elements.length, ...(note ? { note } : {}) };
}

  server.registerTool(
    'layout_net',
    {
      title: 'Auto-layout a net for the editor',
      description:
        'Recompute a clean designtime layout for an existing net. Default engine "auto" asks the platform\u2019s SEMANTIC layout engine first (master /api/llm/layout — the LLM reasons over the CONCRETE net: ids, labels and arcs, so it groups branches, exposes cycles and respects meaning) and falls back to the deterministic serpentine grid (200px pitch, spine folds every 10 elements, config/hub places banded between the rows they serve, sinks on their own bottom row) when no provider is available or the answer is incomplete. "grid" is free and deterministic; "llm" insists on the semantic engine and errors without it. Run this after building or restructuring a net — a net a human cannot read in the editor is not finished. Only positions change; labels and structure are never modified.',
      inputSchema: {
        netId: z.string(),
        sessionId: z.string().optional().describe(`Session holding the net (default: ${config.session})`),
        engine: z
          .enum(['auto', 'llm', 'grid'])
          .optional()
          .describe('auto (default): semantic LLM layout with grid fallback. llm: semantic only, error without a provider. grid: deterministic serpentine, zero LLM cost.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'layout_net', mutates: true }, async (model, args) => {
      return relayoutNet(ctx, model, String(args.netId), String(args.sessionId ?? config.session), (args.engine as any) ?? 'auto');
    }),
  );

  server.registerTool(
    'add_transitions',
    {
      title: 'Add several transitions in one call',
      description:
        'Batch form of add_transition. Items run sequentially so writes stay deterministic; one failure does not abort later items. Returns an explicit per-item success/error summary.',
      inputSchema: {
        netId: z.string(),
        transitions: z.array(batchTransitionSchema).min(1).max(100),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'add_transitions', mutates: true }, async (model, args) => {
      const results: any[] = [];
      for (const item of args.transitions as any[]) {
        const call: any = await addTransitionHandler({ ...item, netId: args.netId, model });
        let payload: any = {};
        try {
          payload = JSON.parse(call?.content?.[0]?.text ?? '{}');
        } catch {
          payload = { error: call?.content?.[0]?.text ?? 'unknown add_transition result' };
        }
        results.push(
          call?.isError
            ? { id: item.transitionId, ok: false, error: payload.error ?? payload }
            : { id: item.transitionId, ok: true, result: payload },
        );
      }
      const succeeded = results.filter((r) => r.ok).length;
      // Layout is a general invariant, not an afterthought: after a batch build the net gets an
      // automatic serpentine relayout so the editor view matches what was built. Best-effort —
      // a layout failure must never fail the build itself.
      let layout: any;
      try {
        if (succeeded > 0) layout = await relayoutNet(ctx, model, String(args.netId), config.session, 'grid');
      } catch (e: any) {
        layout = { error: String(e?.message ?? e), note: 'run layout_net manually' };
      }
      return {
        netId: args.netId,
        requested: results.length,
        succeeded,
        failed: results.length - succeeded,
        partialSuccess: succeeded > 0 && succeeded < results.length,
        results,
        ...(layout ? { layout } : {}),
      };
    }),
  );

  // Field finding F13 (user-confirmed): structural mistakes were PERMANENT on the curated
  // surface — no way to remove a mis-built transition or net without AGENTICOS_NATIVE_TOOLS=all.
  // These wrap the same native DELETE_* paths (stop-first, best-effort deregistration).
  server.registerTool(
    'delete_transition',
    {
      title: 'Delete a transition (stop + deregister)',
      description:
        'Remove a transition permanently: stops it, then removes its runtime registration, inscription, status and assignment. Tokens in its places are untouched. Use for mis-built or orphaned lanes; the designtime PNML element (canvas shape) stays until its net is deleted.',
      inputSchema: {
        transitionId: z.string(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'delete_transition', mutates: true }, async (model, args) => {
      const res: any = await ctx.executorFor(model).execute('DELETE_TRANSITION', { transitionId: args.transitionId });
      if (res?.success === false) throw new Error(String(res.error ?? 'DELETE_TRANSITION failed'));
      return { deleted: args.transitionId, ...(res?.data ?? {}) };
    }),
  );

  server.registerTool(
    'delete_net',
    {
      title: 'Delete a net (designtime structure + its transitions)',
      description:
        'Remove a net\'s designtime structure (places, transitions, arcs on the canvas) and — by default — deregister its runtime transitions too. Pass deleteTransitions:false to keep runtime transitions (they are model-global and may be shared across nets). Tokens in runtime places are NOT deleted (use delete_tokens). Permanent; there is no undo.',
      inputSchema: {
        netId: z.string(),
        deleteTransitions: z
          .boolean()
          .optional()
          .describe('Default true: also stop + deregister every transition in the net\'s PNML. Set false if transitions are shared with another net.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'delete_net', mutates: true }, async (model, args) => {
      const res: any = await ctx.executorFor(model).execute('DELETE_NET', {
        netId: args.netId,
        deleteTransitions: args.deleteTransitions ?? true,
      });
      if (res?.success === false) throw new Error(String(res.error ?? 'DELETE_NET failed'));
      return { ...(res?.data ?? { deleted: args.netId }) };
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
        intervalMs: z.number().positive().optional(),
        timezone: z.string().optional().describe('Cron only: IANA zone id, e.g. Europe/Berlin; default = server zone'),
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
      if (args.scheduleCron && args.intervalMs) throw new Error('scheduleCron and intervalMs are alternatives; provide only one');
      if (args.timezone !== undefined && !args.scheduleCron) throw new Error('timezone only applies to scheduleCron');
      if (args.scheduleCron) validateCron(args.scheduleCron);
      const kids = await ctx.node.getChildren(model, `root/workspace/transitions/${args.transitionId}`);
      const leaf = (kids ?? []).find((c: any) => c.name === 'inscription');
      const value = leaf?.properties?.value ?? leaf?.value;
      if (!value) throw new Error(`no inscription found for ${args.transitionId}`);
      const inscription = JSON.parse(value);
      inscription.schedule = args.scheduleCron
        ? { type: 'cron', cron: args.scheduleCron, ...(args.timezone ? { timezone: args.timezone } : {}) }
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

  for (const [name, verb, tool] of [
    ['start_net', 'start', 'START_TRANSITION'],
    ['stop_net', 'stop', 'STOP_TRANSITION'],
  ] as const) {
    server.registerTool(
      name,
      {
        title: `${verb === 'start' ? 'Start' : 'Stop'} every firing lane in a net`,
        description:
          verb === 'start'
            ? 'Start every firing transition of a net in ONE call. Structural kind:"link" transitions are skipped automatically — they carry no tokens and never fire, so starting them is meaningless. Sequential and NOT atomic: the result lists each transition with started/skipped/failed and the reason, so a partial start is visible rather than assumed.'
            : 'Stop every firing transition of a net in ONE call — the per-net kill switch. Structural kind:"link" transitions are skipped (they never ran). Sequential and NOT atomic: the result lists each transition with stopped/skipped/failed, so a lane that refused to stop is named instead of silently left running.',
        inputSchema: {
          netId: z.string().describe('Net whose transitions to act on'),
          ...modelParam,
        },
      },
      wrapTool(scope, config.mode, { name, mutates: true }, async (model, args) => {
        const listed = await ctx.executorFor(model)
          .execute('LIST_ALL_INSCRIPTIONS', { includeContent: true });
        if (!listed.success) throw new Error(listed.error ?? 'LIST_ALL_INSCRIPTIONS failed');
        const raw: any = listed.data ?? {};
        const all: any[] = Array.isArray(raw) ? raw : (raw.inscriptions ?? raw.results ?? []);

        const inNet = all.filter((entry: any) => {
          const ins = entry?.inscription ?? entry?.content ?? entry;
          return String(ins?.metadata?.netId ?? '') === String(args.netId);
        });
        if (inNet.length === 0) {
          throw new Error(
            `no transitions found for net '${args.netId}' in model '${model}' — check the netId with net_overview `
            + '(a net whose transitions were built elsewhere carries a different metadata.netId)',
          );
        }

        const results: Array<Record<string, any>> = [];
        let acted = 0;
        for (const entry of inNet) {
          const ins = entry?.inscription ?? entry?.content ?? entry;
          const id = String(ins?.id ?? entry?.transitionId ?? entry?.id ?? '');
          const kind = String(ins?.kind ?? 'unknown');
          if (!id) continue;
          // Links are structure, not lanes. Trying to start one is a no-op at best and an
          // error at worst, and either way it is noise in the report.
          if (kind === 'link') {
            results.push({ transitionId: id, kind, skipped: 'structural link — never fires' });
            continue;
          }
          const res = await ctx.executorFor(model).execute(tool, { transitionId: id });
          if (res.success) {
            acted++;
            results.push({ transitionId: id, kind, [verb === 'start' ? 'started' : 'stopped']: true });
          } else {
            results.push({ transitionId: id, kind, failed: res.error ?? `${tool} failed` });
          }
        }
        const failed = results.filter((r) => r.failed).length;
        return {
          net: args.netId,
          transitions: inNet.length,
          [verb === 'start' ? 'started' : 'stopped']: acted,
          skippedLinks: results.filter((r) => r.skipped).length,
          failed,
          results,
          ...(failed
            ? { note: `${failed} transition(s) did not ${verb} — see results[].failed` }
            : {}),
        };
      }),
    );
  }

  for (const [name, tool, description] of [
    ['fire_once', 'FIRE_ONCE', 'Fire a map/http/command/pass transition once (manual trigger). By default preserveRunning:true atomically tests an already-RUNNING lane without stopping it; action side effects still happen. NOT for llm/agent lanes: run those server-side by start_transition, or client-side via host_transition / EXECUTE_TRANSITION_SMART.'],
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
                preserveRunning: z
                  .boolean()
                  .optional()
                  .describe('Default true: acquire the scheduler in-flight guard and test a RUNNING lane without changing its lifecycle state. Set false for legacy 409-while-running behavior.'),
                boundTokens: z
                  .enum(['counts', 'full'])
                  .optional()
                  .describe('Default "counts": bound tokens are summarized per preset (count + token names) — the full echo repeated every bound token twice and drowned the part that matters (emissions). "full" returns the complete bound-token payload.'),
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
          res = await ctx.executorFor(model).execute(tool, {
            transitionId: args.transitionId,
            ...(name === 'fire_once' ? { preserveRunning: args.preserveRunning ?? true } : {}),
          });
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
          const clamped: any = clampValues(payload, max, state);
          // V2-6: the full bound-token echo (data + _meta.properties, per token, per fire) was
          // the single largest source of context noise in a fire-heavy session, and it buried
          // `emissions` — the answer to the question fire_once asks. Summarize by default and
          // put the answer first.
          if ((args.boundTokens ?? 'counts') !== 'full' && clamped.boundTokens && typeof clamped.boundTokens === 'object') {
            const summary: Record<string, any> = {};
            for (const [preset, toks] of Object.entries(clamped.boundTokens as Record<string, any>)) {
              const list = Array.isArray(toks) ? toks : [];
              summary[preset] = {
                count: list.length,
                tokens: list.slice(0, 10).map((t: any) => t?.name ?? t?.id ?? t?._meta?.name ?? '?'),
              };
            }
            clamped.boundTokens = summary;
            clamped.boundTokensNote = 'summarized — pass boundTokens:"full" for the complete payload';
          }
          const { success, emissions, emittedCount, produced, toPlaces, consumed, note, ...rest } = clamped;
          const ordered = {
            ...(success !== undefined ? { success } : {}),
            ...(emissions !== undefined ? { emissions } : {}),
            ...(emittedCount !== undefined ? { emittedCount } : {}),
            ...(produced !== undefined ? { produced } : {}),
            ...(toPlaces !== undefined ? { toPlaces } : {}),
            ...(consumed !== undefined ? { consumed } : {}),
            ...(note !== undefined ? { note } : {}),
            ...rest,
          };
          if (state.truncated) {
            const truncNote = `long values shortened to ${max} chars for this response only — the stored token is intact; read it with query_tokens, or re-fire with maxResponseChars:0`;
            return {
              ...ordered,
              truncated: true,
              // keep the engine's own note (e.g. "all guards suppressed") next to the truncation one
              note: note !== undefined ? `${note} | ${truncNote}` : truncNote,
            };
          }
          return ordered;
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
        'Persona-first builder: stand up a COMPLETE specialist net (charter + task inbox + bounded multi-step agent + output). `execution:"auto"` checks llm_health: READY/ONLINE uses the server provider; without one it creates an honest connected-client lane. A Claude Code or Codex client on the same Desktop machine should proactively propose and explicitly select its matching CLI backend. CLI-backed personas run unattended on master without a server LLM provider; the binary must be installed and reachable by Desktop/master. Use a preset (developer | reviewer | researcher | operator | assistant), or give a domain role. Feed p-<name>-task; spawn several specialists to form a team. capability:"execute" grants command/tool-net access (rwxhl---t); default reason is rw--.',
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
        execution: z
          .enum(['auto', 'server', 'claude-code', 'codex', 'connected-client'])
          .optional()
          .describe('Reasoning backend (default auto): server provider; unattended headless Claude Code/Codex on master; or the connected MCP host model via external fires'),
        mcp: MCP_SERVER_SCHEMA.optional().describe('External MCP servers this persona may call via MCP_CALL. The m role flag is added automatically. Store each server\'s secret with set_transition_credentials under its credentialKey. To give the persona THIS Agentic-Nets server (token handling included), spawn it and then call attach_mcp_server {transitionId:"t-<name>-work", self:true}'),
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
      const requestedExecution = String(args.execution ?? 'auto');
      let providerStatus = 'UNKNOWN';
      let cliBinaries: Record<string, boolean> | undefined;
      if (requestedExecution !== 'connected-client') {
        const health: any = await ctx.client.masterApi('GET', '/llm/health').catch(() => null);
        providerStatus = String(health?.status ?? 'UNKNOWN').toUpperCase();
        cliBinaries = health?.headlessCliBinaries;
      }
      const execution = requestedExecution !== 'auto'
        ? requestedExecution
        : isLlmHealthReady(providerStatus) ? 'server' : 'connected-client';
      if (execution === 'server' && args.start !== false
          && providerStatus !== 'UNKNOWN' && !isLlmHealthReady(providerStatus)) {
        throw new Error(
          `server execution was requested, but llm_health is ${providerStatus}; nothing was created. `
          + 'Choose execution:"claude-code"|"codex"|"connected-client", repair the provider, '
          + 'or pass start:false to stage the persona without running it.',
        );
      }
      const cliBinary = execution === 'codex' ? 'codex' : execution === 'claude-code' ? 'claude' : undefined;
      // Fail fast on a CLI backend master cannot actually spawn — a persona built anyway would
      // schedule, fire, exit 127 and flap. Masters without the probe field stay permissive.
      if (cliBinary && args.start !== false && cliBinaries && cliBinaries[cliBinary] === false) {
        throw new Error(
          `master cannot reach the ${cliBinary} CLI (llm_health.headlessCliBinaries.${cliBinary}=false); `
          + 'nothing was created. Install the CLI where Desktop/master runs (restart the app to re-probe), '
          + 'pick the other binary, execution:"connected-client", or pass start:false to stage it.',
        );
      }
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
            execution,
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
        ...(args.mcp ? { mcp: args.mcp } : {}),
        tier: tier === 'high' ? 'high' : undefined,
        maxIterations: args.maxIterations,
        ...(cliBinary ? { llmMode: 'bash' as const, binary: cliBinary as 'claude' | 'codex' } : {}),
        capacity: args.capacity ?? 50,
        scheduleCron: args.scheduleCron,
        intervalMs: args.intervalMs,
      });
      await assignInscription(ctx, model, inscription, agentFor('agent'));
      await persistInscriptionLeaf(ctx, model, netId, workTid, inscription);

      let started = false;
      let external = false;
      if (execution === 'connected-client' && args.start !== false) {
        await ctx.client.masterApi('POST', `/transitions/${encodeURIComponent(workTid)}/external`, {
          modelId: model,
          external: true,
        });
        external = true;
      } else if (args.start !== false) {
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
        execution,
        executionBackend: cliBinary ? `headless-cli:${cliBinary}` : execution === 'server' ? 'server-provider' : 'connected-client',
        ...(requestedExecution !== 'connected-client'
          ? { providerStatusAtCreation: providerStatus } : {}),
        charter,
        taskPlace: task,
        outputPlace: output,
        transition: workTid,
        started,
        external,
        created,
        note: cliBinary
          ? `This persona keeps the full agent loop and runs unattended through the local ${cliBinary} CLI; no server LLM provider is required.`
          : execution === 'connected-client'
            ? args.start === false
              ? 'No server/CLI backend was selected. The persona remains deployed and stopped until a client explicitly starts or marks it external.'
              : 'No server/CLI backend was selected, so this persona is marked external and runs only while a connected client serves its fires.'
            : !isLlmHealthReady(providerStatus) && providerStatus !== 'UNKNOWN'
              ? `This persona is staged for the server provider, which is currently ${providerStatus}; it will not reason until that provider is healthy and the transition is started.`
              : 'This persona is owned by master and uses the configured server LLM provider.',
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
