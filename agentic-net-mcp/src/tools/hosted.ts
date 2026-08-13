/**
 * Client-hosted transitions — THE inversion: an llm/agent transition that is
 * deliberately NOT running on master. This MCP process is its executor,
 * powered by the LLM the *client side* already has (default: the local
 * `claude` binary — the user's own subscription; or ollama / anthropic /
 * openai / openrouter / codex via AGENTICOS_LLM_PROVIDER).
 *
 * Semantics (honest): a hosted transition executes only while this MCP server
 * is alive (i.e. while your client session is connected). Tokens that arrive
 * while nobody is hosting simply WAIT in the input place — nothing is lost;
 * the net's persistence is exactly what makes this safe. For 24/7 lanes, keep
 * the transition on master instead.
 *
 * Built on the CLI's proven local runtime: executeTransitionLocally() reads
 * the inscription, binds presets via ArcQL, runs the sub-agent loop on the
 * configured provider, consumes inputs, and verifies postset emission.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeTransitionLocally } from '@agenticos/cli/agent/transition-executor';
import { createLlmProvider } from '@agenticos/cli/commands/llm-factory';
import type { LlmProvider } from '@agenticos/cli/llm/provider';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

export interface HostedRunner {
  transitionId: string;
  model: string;
  intervalMs: number;
  timer?: ReturnType<typeof setTimeout>;
  executing: boolean;
  stats: {
    since: string;
    ticks: number;
    executions: number;
    successes: number;
    failures: number;
    lastError?: string;
    lastSuccessAt?: string;
    lastSummary?: string;
  };
}

const IDLE = /No tokens bound for required presets/i;
const MIN_INTERVAL_MS = 2000;

function hostedKey(model: string, transitionId: string): string {
  return `${model}::${transitionId}`;
}

/** Build the CLI provider from MCP env config (lazy, cached on the context). */
export function llmFor(ctx: AppContext): LlmProvider {
  if (!ctx.hostedLlm) {
    const c = ctx.config;
    const section = { model: c.llmModel } as any;
    ctx.hostedLlm = createLlmProvider(
      c.llmProvider,
      {
        gateway_url: c.gatewayUrl,
        model_id: c.models[0],
        session_id: c.session,
        client_id: 'agenticos-admin',
        default_provider: c.llmProvider,
        default_role: 'rw',
        default_tier: c.llmTier,
        anthropic: process.env.ANTHROPIC_API_KEY ? { api_key: process.env.ANTHROPIC_API_KEY, ...section } : undefined,
        openai: process.env.OPENAI_API_KEY ? { api_key: process.env.OPENAI_API_KEY, ...section } : undefined,
        ollama: { base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434', ...section },
        claude_code: { binary: process.env.AGENTICOS_CLAUDE_BINARY, ...section },
        codex: section,
      } as any,
      c.llmTier,
    );
  }
  return ctx.hostedLlm;
}

async function readInscriptionLeaf(ctx: AppContext, model: string, transitionId: string): Promise<any | null> {
  const kids = await ctx.node.getChildren(model, `root/workspace/transitions/${transitionId}`).catch(() => []);
  const leaf = (kids ?? []).find((c: any) => c.name === 'inscription');
  const value = leaf?.properties?.value ?? leaf?.value;
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function executeHostedOnce(ctx: AppContext, model: string, transitionId: string, maxIterations?: number) {
  return executeTransitionLocally(ctx.node, llmFor(ctx), ctx.executorFor(model), model, ctx.config.session, {
    transitionId,
    ...(maxIterations ? { maxIterations } : {}),
  });
}

function scheduleTick(ctx: AppContext, runner: HostedRunner): void {
  runner.timer = setTimeout(async () => {
    // Reentrancy guard: a slow LLM call must never overlap the next tick.
    if (!runner.executing) {
      runner.executing = true;
      runner.stats.ticks++;
      try {
        const res = await executeHostedOnce(ctx, runner.model, runner.transitionId);
        if (res.success) {
          runner.stats.executions++;
          runner.stats.successes++;
          runner.stats.lastSuccessAt = new Date().toISOString();
          runner.stats.lastSummary = (res.summary ?? '').slice(0, 200);
        } else if (!IDLE.test(res.error ?? '')) {
          runner.stats.executions++;
          runner.stats.failures++;
          runner.stats.lastError = (res.error ?? 'unknown').slice(0, 300);
        }
      } catch (err: any) {
        runner.stats.failures++;
        runner.stats.lastError = String(err?.message ?? err).slice(0, 300);
      } finally {
        runner.executing = false;
      }
    }
    // Re-arm unless unhosted meanwhile.
    if (ctx.hostedRunners.has(hostedKey(runner.model, runner.transitionId))) {
      scheduleTick(ctx, runner);
    }
  }, runner.intervalMs);
  // Never keep the process alive just for hosting — the MCP connection does that.
  runner.timer.unref?.();
}

export function stopAllHosted(ctx: AppContext): void {
  for (const runner of ctx.hostedRunners.values()) {
    if (runner.timer) clearTimeout(runner.timer);
  }
  ctx.hostedRunners.clear();
}

export function registerHostedTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'host_transition',
    {
      title: 'Host a transition in THIS process (client-side LLM)',
      description:
        `Execute an llm/agent transition HERE instead of on master, using the client side's own LLM (provider '${config.llmProvider}'${config.llmModel ? `, model ${config.llmModel}` : ''} — zero server-side LLM setup). ` +
        'The transition is stopped on master (so it does not double-fire) and this process becomes its executor: mode "watch" polls its input place and works each arriving token; mode "once" executes a single waiting token now and returns the result. ' +
        'Honest semantics: hosted lanes run only while this session is connected — tokens arriving meanwhile wait safely in the input place. Monitor via net_stats.hosted; stop with unhost_transition. ' +
        'Alternative: when the HOST MODEL itself should do the reasoning (no local provider config at all), use set_external + prepare/complete_external_fire instead — master keeps the emit-rule pipeline and this session supplies the answer.',
      inputSchema: {
        transitionId: z.string(),
        mode: z.enum(['watch', 'once']).optional().describe('watch = keep polling (default); once = single execution now'),
        intervalMs: z.number().optional().describe(`watch poll interval (default 8000, min ${MIN_INTERVAL_MS})`),
        maxIterations: z.number().optional().describe('agent-kind: max reasoning steps per execution'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'host_transition', mutates: true }, async (model, args) => {
      const transitionId = String(args.transitionId);
      const inscription = await readInscriptionLeaf(ctx, model, transitionId);
      if (!inscription) throw new Error(`no inscription found for '${transitionId}' — assign it first (add_transition with start:false)`);
      const kind = inscription.action?.type ?? inscription.kind;
      if (kind !== 'llm' && kind !== 'agent') {
        throw new Error(`host_transition supports llm/agent transitions only (got '${kind}'). Deterministic kinds belong on master/executor — fire_once them.`);
      }
      // Make sure master is NOT also running it — hosting means exclusive execution here.
      await ctx.master.stopTransition(transitionId, model).catch(() => undefined);

      if (args.mode === 'once') {
        const res = await executeHostedOnce(ctx, model, transitionId, args.maxIterations);
        if (!res.success && IDLE.test(res.error ?? '')) {
          return { hosted: 'once', transitionId, executed: false, idle: true, note: 'no token waiting in the input place' };
        }
        if (!res.success) throw new Error(res.error ?? 'hosted execution failed');
        return {
          hosted: 'once',
          transitionId,
          executed: true,
          provider: config.llmProvider,
          iterationsUsed: res.iterationsUsed,
          consumedTokens: res.consumedTokens,
          emittedTokens: res.emittedTokens,
          summary: res.summary,
        };
      }

      const key = hostedKey(model, transitionId);
      const existing = ctx.hostedRunners.get(key);
      if (existing?.timer) clearTimeout(existing.timer);
      const runner: HostedRunner = {
        transitionId,
        model,
        intervalMs: Math.max(MIN_INTERVAL_MS, args.intervalMs ?? 8000),
        executing: false,
        stats: { since: new Date().toISOString(), ticks: 0, executions: 0, successes: 0, failures: 0 },
      };
      ctx.hostedRunners.set(key, runner);
      scheduleTick(ctx, runner);
      return {
        hosted: 'watch',
        transitionId,
        model,
        provider: config.llmProvider,
        intervalMs: runner.intervalMs,
        note: 'This process now executes the transition. It runs while this session is connected; tokens wait safely otherwise. See net_stats.hosted; stop with unhost_transition.',
      };
    }),
  );

  server.registerTool(
    'unhost_transition',
    {
      title: 'Stop hosting a transition',
      description:
        'Stop executing a hosted transition in this process and return its run stats. Does NOT restart it on master — start_transition if you want master to take it back.',
      inputSchema: { transitionId: z.string(), ...modelParam },
    },
    wrapTool(scope, config.mode, { name: 'unhost_transition', mutates: true }, async (model, args) => {
      const key = hostedKey(model, String(args.transitionId));
      const runner = ctx.hostedRunners.get(key);
      if (!runner) throw new Error(`'${args.transitionId}' is not hosted in this process (see net_stats.hosted)`);
      if (runner.timer) clearTimeout(runner.timer);
      ctx.hostedRunners.delete(key);
      return { unhosted: args.transitionId, stats: runner.stats };
    }),
  );
}
