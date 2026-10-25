import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
function path(model: string, id?: string): string {
  return `/explorer/${encodeURIComponent(model)}/rounds${id ? '/' + encodeURIComponent(id) : ''}`;
}
function modelParam(ctx: AppContext): Record<string, z.ZodTypeAny> {
  return ctx.scope.multiModel ? { model: z.string().optional().describe('Target model within this connection’s allowed models') } : {};
}
export function registerFocusRoundReaders(server: McpServer, ctx: AppContext): void {
  server.registerTool('focus_rounds', {
    title: 'Read guided Focus interviews and refinement results',
    description: 'List saved rounds, or read one round with its current question, saved answers and per-operation outcomes. Requires Focus 1.6.0. Pending work resumes when read after a restart. Questions can also be answered through the Interview application. No new round starts automatically.',
    inputSchema: { roundId: identity.optional(), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_rounds', mutates: false }, async (model, args) =>
    ctx.client.masterApi('GET', path(model, args.roundId), undefined, { modelId: model })));
}
export function registerFocusRoundTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('focus_round', {
    title: 'Start, answer, refine or resume a guided Focus round',
    description: 'One topic across its relevant layers, one adaptive multiple-choice question at a time (up to ten, free text accepted). start needs a stable roundId, topic and scope (model, net:session::net, domain:..., tag:...). answer saves a decision; unknown:true investigates evidence and returns a recommendation for the same decision. Only refine seals the answered questions and generates, validates and directly applies definitions and topology within scope. Successful edits survive partial failures; retry resumes unfinished work. Read focus_rounds for progress. Existing source configuration is optional; model-only rounds use a temporary snapshot. Execution uses the installed headless-agent capability with a read-only Claude Code or Codex profile. Each new round must be requested by the person.',
    inputSchema: {
      action: z.enum(['start', 'answer', 'refine', 'retry']), roundId: identity,
      topic: z.string().min(1).optional(), scope: z.string().min(1).optional(),
      profileId: z.enum(['claude-code-read-only', 'codex-read-only']).optional(),
      promptId: z.string().optional(), selected: z.array(z.string()).optional(), text: z.string().optional(),
      unknown: z.boolean().optional(), by: z.string().optional(), ...modelParam(ctx),
    },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round', mutates: true }, async (model, args) => {
    const { action, roundId, model: _model, ...input } = args;
    if (action === 'start' && (!args.topic || !args.scope)) throw new Error('start requires a topic and scope');
    const url = action === 'start' ? path(model) : path(model, roundId) + '/' + action;
    const body = action === 'start' ? { ...input, roundId } : action === 'answer' ? input : {};
    return ctx.client.masterApi('POST', url, body, { modelId: model });
  }));
}
