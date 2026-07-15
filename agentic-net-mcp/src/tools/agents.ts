/**
 * Agent-invocation curated tool — let an MCP client USE the platform agents (the same
 * ones the GUI Universal Assistant drives), not just their tools.
 *
 * `invoke_agent` delegates a task to a named persona (builder / operator / persona /
 * domain-expert / chronicle) via the master's INVOKE_PERSONA tool, then blocks on
 * COLLECT_RESULTS and returns the outcome — one call, a result. It runs the SAME
 * AgentToolExecutor + agent loop the Universal Assistant uses, so the MCP client gets
 * a full autonomous agent (authoring nets, diagnosing, building) on demand.
 *
 * For fire-and-forget or fan-out, the native DELEGATE_TASK / INVOKE_PERSONA +
 * COLLECT_RESULTS tools remain available (rw mode).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

const AGENTS = ['builder', 'operator', 'persona', 'domain-expert', 'chronicle'] as const;

export function registerAgentTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'invoke_agent',
    {
      title: 'Invoke an AgenticOS agent and get its result',
      description:
        'Delegate a task to one of the platform agents and block until it finishes, returning its result. ' +
        'Agents: "builder" authors nets/places/transitions/inscriptions and deploys them; "operator" diagnoses ' +
        'and repairs running nets; "persona" does user-personal work on persona-inhabited models; "domain-expert" ' +
        'answers deep questions; "chronicle" summarizes/records. This runs the SAME agent loop and unified tool ' +
        'framework the GUI Universal Assistant uses. For fire-and-forget or parallel fan-out, use the native ' +
        'DELEGATE_TASK / INVOKE_PERSONA + COLLECT_RESULTS tools instead.',
      inputSchema: {
        agent: z.enum(AGENTS).describe('Which agent/persona to run'),
        prompt: z.string().describe('The task for the agent, in natural language'),
        timeoutMs: z
          .number()
          .optional()
          .describe('Max time to wait for the agent to finish before returning its in-progress status (default 180000).'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'invoke_agent', mutates: true }, async (model, args) => {
      const exec = ctx.executorFor(model);

      const spawn = await exec.execute('INVOKE_PERSONA', {
        persona: args.agent,
        prompt: args.prompt,
      });
      if (!spawn.success) throw new Error(spawn.error ?? 'invoke_agent: INVOKE_PERSONA failed');

      const taskId = (spawn.data as { taskId?: string } | undefined)?.taskId;
      if (!taskId) {
        // No taskId to await (unexpected) — return whatever the spawn gave back.
        return spawn.data ?? { ok: true, note: 'agent spawned but returned no taskId' };
      }

      const timeoutMs = args.timeoutMs ?? 180000;
      const collected = await exec.execute('COLLECT_RESULTS', { taskIds: [taskId], timeoutMs });
      if (!collected.success) {
        // The agent may still be running server-side; surface the taskId so the caller
        // can COLLECT_RESULTS again rather than treating a wait-timeout as a hard failure.
        return {
          agent: args.agent,
          taskId,
          completed: false,
          note: collected.error ?? 'result not ready yet; call COLLECT_RESULTS with this taskId to retrieve it',
        };
      }
      return { agent: args.agent, taskId, ...(collected.data as object) };
    }),
  );

  server.registerTool(
    'start_domain_expert',
    {
      title: 'Start (bootstrap) the model’s domain expert',
      description:
        'Make the domain-expert a first-class, self-maintaining inhabitant of the model: creates the ' +
        'domain-memory skeleton (p-{model}-domain-{entrypoints,routing,knowledge,journal}) AND a ' +
        'scheduled t-{model}-domain-maintain agent that keeps that memory filled server-side. ' +
        'Idempotent (returns domainBootstrap "created" or "existing"). Do this ONCE per model — ' +
        'invoke_agent{agent:"domain-expert"} alone answers one-shot but never bootstraps the skeleton ' +
        'or the maintain lane, so a fresh model’s domain expert has no durable, auto-refreshed memory ' +
        'until you call this. After it, a model user asks via invoke_agent and gets answers grounded ' +
        'in memory that stays current.',
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe('Optional conversation/session id; a fresh one is generated if omitted.'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'start_domain_expert', mutates: true }, async (model, args) => {
      const query = args?.sessionId ? { sessionId: String(args.sessionId) } : undefined;
      const res: any = await ctx.client.masterApi(
        'POST',
        `/assistant/p/domain-expert/${model}/chat/start`,
        undefined,
        query,
      );
      return res ?? { ok: true, note: 'domain-expert start returned no body' };
    }),
  );
}
