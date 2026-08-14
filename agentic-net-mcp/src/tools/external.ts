/**
 * External fires — the host model IS the LLM.
 *
 * An llm/agent transition with status `external` is dormant on master (the schedulers only fire
 * running/starting) and is instead fired by an external client: THIS session. Unlike
 * host_transition (which needs a locally configured provider), external fires need NO provider
 * at all — prepare_external_fire returns the exact interpolated prompt a master fire would use,
 * the MCP client answers it itself, and complete_external_fire hands the answer back to master,
 * which runs the SAME emit-rule pipeline / agent emission semantics as a master fire. External
 * execution is semantically identical to master execution — only the brain differs.
 *
 * The external status is a recommendation/discovery marker, not a hard gate: any *stopped*
 * llm/agent transition can also be prepared/completed on explicit request (includeStopped).
 * Running transitions are refused — they belong to master's schedulers.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

function llmGuidance(transitionId: string, fireId: string): string {
  return (
    `YOU are the LLM for this fire. Read systemPrompt + prompt above, produce the answer ` +
    `(JSON only unless the systemPrompt says otherwise), then call ` +
    `complete_external_fire {transitionId:"${transitionId}", fireId:"${fireId}", response:"<your raw answer>"}. ` +
    `Master parses it and routes it through the transition's emit rules exactly like a master fire.`
  );
}

function agentGuidance(transitionId: string, fireId: string, allowedTools: string[] = []): string {
  const tools = allowedTools.length
    ? ` You may use ONLY these canonical tools: ${allowedTools.join(', ')}.`
    : '';
  return (
    `YOU are the agent for this fire. Perform the task in \`nl\` under the returned role, ` +
    `capabilityProfile, and resourceScopes.${tools} Every tool call is authorized by master. ` +
    `When done, call complete_external_fire ` +
    `{transitionId:"${transitionId}", fireId:"${fireId}", emissions:[{place:"<postset>", data:{...}}]} ` +
    `— or just {summary:"..."} to auto-emit to a sole postset. Master emits, consumes the shown ` +
    `boundTokens, and records the fire. If you cannot do the task, call it with success:false ` +
    `(inputs are preserved for retry) or abandon_external_fire.`
  );
}

export function registerExternalTools(server: McpServer, ctx: AppContext): void {
  registerExternalReaders(server, ctx);
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'set_external',
    {
      title: 'Mark llm/agent transitions as externally fired (bulk-capable)',
      description:
        'Flip llm/agent transitions to status `external`: master leaves them alone and clients fire them via prepare/complete_external_fire with the CLIENT\'s own LLM — the host model itself. ' +
        'Scope one transition (transitionId), a list (transitionIds), a whole net (netId [+sessionId]), a whole session (sessionId), or every llm/agent transition of the model (all:true). ' +
        'external:false returns them to `stopped`; start_transition hands one back to master execution. Non-llm/agent transitions are skipped and reported.',
      inputSchema: {
        external: z.boolean().describe('true = mark external (master skips); false = back to stopped'),
        transitionId: z.string().optional(),
        transitionIds: z.array(z.string()).optional(),
        netId: z.string().optional().describe('Flip all llm/agent transitions of this designtime net'),
        sessionId: z.string().optional().describe(`Session for netId lookup, or flip a whole session's nets (default ${config.session})`),
        all: z.boolean().optional().describe('Flip every llm/agent transition of the model'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'set_external', mutates: true }, async (model, args) => {
      const external = Boolean(args.external);
      const targets = await resolveTargets(ctx, model, args);
      const individualTarget =
        Boolean(args.transitionId) ||
        (Array.isArray(args.transitionIds) && args.transitionIds.length > 0);
      const policyScope = individualTarget
        ? undefined
        : args.netId
          ? 'net'
          : args.sessionId
            ? 'session'
            : args.all
              ? 'model'
              : undefined;
      if (policyScope) {
        const policy = await ctx.client.masterApi('POST', '/transitions/external/policy', {
          modelId: model,
          scope: policyScope,
          scopeId:
            policyScope === 'net'
              ? `${String(args.sessionId ?? config.session)}/${String(args.netId)}`
              : policyScope === 'session'
                ? String(args.sessionId)
                : undefined,
          external,
          transitionIds: targets,
        });
        return {
          ...policy,
          ...(external
            ? {
                note:
                  'This persistent policy also applies to newly deployed llm/agent transitions carrying the same model/session/net metadata.',
              }
            : {}),
        };
      }
      if (!targets.length) {
        throw new Error('no target transitions — pass transitionId, transitionIds, netId, sessionId, or all:true');
      }
      const results: any[] = [];
      for (const tid of targets) {
        try {
          const res = await ctx.client.masterApi('POST', `/transitions/${encodeURIComponent(tid)}/external`, {
            modelId: model,
            external,
          });
          results.push({ transitionId: tid, ...res });
        } catch (err: any) {
          results.push({ transitionId: tid, skipped: true, reason: String(err?.body ?? err?.message ?? err).slice(0, 200) });
        }
      }
      const flipped = results.filter((r) => !r.skipped).length;
      return {
        external,
        flipped,
        skipped: results.length - flipped,
        results,
        ...(external && flipped
          ? { note: 'These transitions now wait for YOU. list_external_fires shows when they have work; prepare_external_fire starts a fire.' }
          : {}),
      };
    }),
  );

  server.registerTool(
    'prepare_external_fire',
    {
      title: 'Prepare an external fire — get the prompt + bound tokens',
      description:
        'Fire ANY llm/agent transition YOURSELF, on demand, whatever its status — external, stopped, or running; being marked external is NOT required (set_external is a standing policy, not a precondition). Master binds and leases the preset tokens and builds the exact interpolated prompt a master fire would use, and returns them with a fireId. ' +
        'llm kind → answer `prompt` and submit via complete_external_fire {response}. agent kind → do the task in `nl` using only returned allowedTools/resourceScopes, then complete with {emissions} or {summary}. ' +
        'Returns ready:false (no fireId) when the input places have no tokens or another fire holds their lease. Preparing a running lane is a takeover (`takenOverFromMaster:true` — master stands down for the duration; the token lease arbitrates any race). Only `starting` is refused (mid-executor-handshake). Deterministic kinds (pass/map/http/command) are fired on demand with fire_once instead.',
      inputSchema: { transitionId: z.string(), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'prepare_external_fire', mutates: true }, async (model, args) => {
      const tid = String(args.transitionId);
      const res = await ctx.client.masterApi('POST', `/transitions/${encodeURIComponent(tid)}/external/prepare`, {
        modelId: model,
      });
      if (res?.ready && res?.fireId) {
        if (res.kind === 'agent') {
          ctx.activateExternalAgentFire(model, {
            transitionId: tid,
            fireId: String(res.fireId),
            sessionId: res.sessionId ? String(res.sessionId) : undefined,
            allowedTools: Array.isArray(res.allowedTools) ? res.allowedTools.map(String) : [],
          });
        }
        res.instructions =
          res.kind === 'llm'
            ? llmGuidance(tid, res.fireId)
            : agentGuidance(
                tid,
                res.fireId,
                Array.isArray(res.allowedTools) ? res.allowedTools.map(String) : [],
              );
      }
      return res;
    }),
  );

  server.registerTool(
    'complete_external_fire',
    {
      title: 'Complete an external fire — master applies your answer',
      description:
        'Hand your result back to master, which runs the SAME pipeline as a master fire: llm kind → your `response` is parsed and routed through the emit rules (when-conditions, error branches, correlation); agent kind → your `emissions` are emitted (or `summary` auto-emitted to a sole postset). ' +
        'Master then consumes exactly the boundTokens shown at prepare time and records the fire with provider external:<worker> (never counted against the master LLM breaker). ' +
        'success:false — agent kind ALWAYS preserves the inputs for retry; llm kind routes the error through a matching when:"error" emit rule (error token emitted, inputs CONSUMED — the failure is recorded in the net, same as a native fire), and only preserves the inputs when no emit rule matches. Use abandon_external_fire when you want a guaranteed no-trace release. ' +
        'Completion is idempotent: retrying the same fireId returns the original result without emitting twice, and a rejected (400) body never burns the fireId.',
      inputSchema: {
        transitionId: z.string(),
        fireId: z.string().describe('From prepare_external_fire'),
        response: z.string().optional().describe('llm kind: your raw model answer (JSON preferred)'),
        emissions: z
          .array(z.object({ place: z.string().describe('Postset name or place name'), data: z.any() }))
          .optional()
          .describe('agent kind: explicit output tokens'),
        summary: z.string().optional().describe('agent kind: auto-emitted to a sole postset when no emissions given'),
        success: z.boolean().optional().describe('default true; false = failed fire, inputs preserved'),
        error: z.string().optional().describe('failure reason when success:false'),
        usage: z
          .object({ promptTokens: z.number().optional(), completionTokens: z.number().optional() })
          .optional()
          .describe('your real token usage, if known (otherwise estimated)'),
        llmModel: z.string().optional().describe('the model YOU used (recorded as resolvedModel in usage_report)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'complete_external_fire', mutates: true }, async (model, args) => {
      const transitionId = String(args.transitionId);
      const fireId = String(args.fireId);
      // Friendly shape validation BEFORE the wire (master's 400s stay the backstop, and a
      // rejected body never burns the fireId — the lease survives for a corrected retry).
      const failed = args.success === false;
      const hasResponse = typeof args.response === 'string' && args.response.length > 0;
      const hasEmissions = Array.isArray(args.emissions) && args.emissions.length > 0;
      const hasSummary = typeof args.summary === 'string' && args.summary.trim().length > 0;
      if (failed && !(typeof args.error === 'string' && args.error.trim().length > 0)) {
        throw new Error(
          "success:false requires 'error' (the failure reason) — it is routed to when:\"error\" rules (llm) or recorded for the retry (agent)",
        );
      }
      if (!failed && !hasResponse && !hasEmissions && !hasSummary) {
        throw new Error(
          ctx.isActiveAgentFire(model, transitionId, fireId)
            ? "agent external fire requires 'emissions' (structured tokens) or 'summary' (auto-emitted to a sole postset)"
            : "a successful completion needs a result: 'response' (llm kind) or 'emissions'/'summary' (agent kind)",
        );
      }
      const result = await ctx.client.masterApi('POST', `/transitions/${encodeURIComponent(transitionId)}/external/complete`, {
        modelId: model,
        fireId,
        response: args.response,
        emissions: args.emissions,
        summary: args.summary,
        success: args.success,
        error: args.error,
        usage: args.usage,
        worker: `mcp-${config.session}`,
        model: args.llmModel,
      });
      ctx.clearExternalAgentFire(model, transitionId, fireId);
      return result;
    }),
  );

  server.registerTool(
    'abandon_external_fire',
    {
      title: 'Abandon a prepared external fire',
      description:
        'Drop a prepared fire without firing it and release its token lease. The tokens stay in the input places and can be prepared again later.',
      inputSchema: { transitionId: z.string(), fireId: z.string(), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'abandon_external_fire', mutates: true }, async (model, args) => {
      const transitionId = String(args.transitionId);
      const fireId = String(args.fireId);
      const result = await ctx.client.masterApi('POST', `/transitions/${encodeURIComponent(transitionId)}/external/abandon`, {
        modelId: model,
        fireId,
      });
      ctx.clearExternalAgentFire(model, transitionId, fireId);
      return result;
    }),
  );
}

/** Readonly-safe subset: discovery only (GET-based). */
export function registerExternalReaders(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'list_external_fires',
    {
      title: 'AI lanes YOU can fire',
      description:
        'Which llm/agent transitions this session can execute, with a `servable` verdict per lane. ' +
        'By default lists the ones marked `external` (plus stopped ones with includeStopped:true). ' +
        '**includeAll:true lists EVERY llm/agent lane of the model whatever its status** — use it when ' +
        'master has no LLM provider, because provider-backed lanes nobody marked by hand are still yours ' +
        'to serve. Headless CLI agent lanes remain master-owned and report executionBackend + ' +
        'requiresServerLlmProvider:false. servableReason: MARKED_EXTERNAL (you own it) · MASTER_HAS_NO_PROVIDER ' +
        '(stranded — master cannot run it) · CLI_BINARY_MISSING (stranded — a bash-backed lane whose ' +
        'claude/codex is unreachable by master; install it or serve the lane yourself) · LANE_IDLE ' +
        '(idle, free to serve) · MASTER_OWNS_IT (a provider ' +
        'exists and master fires it) · NO_TOKENS_BOUND · POSTSET_AT_CAPACITY · FIRE_IN_FLIGHT · NOT_DEPLOYED. ' +
        'The verdict is advice, not a gate: you may still fire a non-servable lane on explicit request. ' +
        'Workflow: list → prepare_external_fire → reason as the host model → complete_external_fire.',
      inputSchema: {
        includeStopped: z.boolean().optional().describe('Also list stopped llm/agent transitions (default false)'),
        includeAll: z
          .boolean()
          .optional()
          .describe('List every llm/agent lane whatever its status, each with a servable verdict (default false)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'list_external_fires', mutates: false }, async (model, args) => {
      const res = await ctx.client.masterApi('GET', '/transitions/external/ready', undefined, {
        modelId: model,
        ...(args.includeStopped ? { includeStopped: 'true' } : {}),
        ...(args.includeAll ? { includeAll: 'true' } : {}),
      });
      const rows: any[] = res?.transitions ?? [];
      // The ONE "has work for this session" predicate: bound tokens AND actually yours to serve.
      // `ready` alone also matches MASTER_OWNS_IT lanes a provider-backed master fires itself.
      const ready = rows.filter((t) => t.ready && t.servable !== false);
      // Lanes master cannot run at all: the ones that quietly go nowhere until a client shows up.
      // CLI_BINARY_MISSING is stranded the same way — a bash-backed lane whose claude/codex master
      // cannot reach never fires server-side either.
      const STRANDED_REASONS = ['MASTER_HAS_NO_PROVIDER', 'CLI_BINARY_MISSING'];
      const stranded = rows.filter((t) => STRANDED_REASONS.includes(t.servableReason));
      const servable = rows.filter((t) => t.servable === true);
      const strandedWhy = (t: any) =>
        t.servableReason === 'CLI_BINARY_MISSING' ? 'missing CLI binary' : 'no LLM provider';
      return {
        ...res,
        ...(stranded.length ? { stranded: stranded.map((t) => t.transitionId) } : {}),
        ...(stranded.length
          ? {
              next:
                `${stranded.length} lane(s) are stranded — master cannot run them, so only this session can: ` +
                `${stranded.map((t) => `${t.transitionId} (${strandedWhy(t)})`).join(', ')}. ` +
                `prepare_external_fire {transitionId} to start.`,
            }
          : ready.length
            ? { next: `${ready.length} transition(s) have work — prepare_external_fire {transitionId} to start a fire` }
            : {}),
        // Discovery bridge: without this a client never learns the wider view exists, because the
        // default list is exactly the one that hides the stranded lanes.
        ...(!args.includeAll && res?.provider?.canFireAiLanes === false
          ? {
              hint:
                'master has no LLM provider — call again with includeAll:true to see every provider-backed '
                + 'llm/agent lane you could run; CLI-backed personas remain master-owned',
            }
          : {}),
        ...(servable.length ? { servableCount: servable.length } : {}),
      };
    }),
  );
}

/** Resolve the set of target transition ids for set_external's scopes. */
async function resolveTargets(ctx: AppContext, model: string, args: Record<string, any>): Promise<string[]> {
  if (args.transitionId) return [String(args.transitionId)];
  if (Array.isArray(args.transitionIds) && args.transitionIds.length) return args.transitionIds.map(String);

  if (args.netId) {
    const session = String(args.sessionId ?? ctx.config.session);
    return netTransitionIds(ctx, model, session, String(args.netId));
  }
  if (args.sessionId) {
    // Whole session: every net's transitions (name convention: node name = transitionId).
    const session = String(args.sessionId);
    const nets = await ctx.node
      .getChildren(model, `root/workspace/sessions/${session}/workspace-nets`)
      .catch(() => []);
    const ids: string[] = [];
    for (const net of nets ?? []) {
      ids.push(...(await netTransitionIds(ctx, model, session, String((net as any).name))));
    }
    return [...new Set(ids)];
  }
  if (args.all) {
    // includeAll IS "every llm/agent lane of the model", resolved server-side by the same
    // predicate master uses. This used to sweep /runtime/transitions and re-derive the kind
    // here, which meant two calls and a second, drifting copy of "is this an AI lane".
    const res: any = await ctx.client
      .masterApi('GET', '/transitions/external/ready', undefined, { modelId: model, includeAll: 'true' })
      .catch(() => null);
    const listed: string[] = (res?.transitions ?? []).map((t: any) => String(t.transitionId));
    return [...new Set(listed)].filter((id) => id && id !== '?' && id !== 'undefined');
  }
  return [];
}

async function netTransitionIds(ctx: AppContext, model: string, session: string, netId: string): Promise<string[]> {
  const kids = await ctx.node
    .getChildren(model, `root/workspace/sessions/${session}/workspace-nets/${netId}/pnml/net/transitions`)
    .catch(() => []);
  return (kids ?? []).map((c: any) => String(c.name)).filter((n: string) => n && n !== 'transitions');
}
