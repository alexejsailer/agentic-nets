import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const requestIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
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
  server.registerTool('focus_round_scope', {
    title: 'Register the areas discovered by the Focus agent',
    description: 'After searching the live model with explore_model and reading definitions, register the existing nets relevant to this goal across its layers. The person never chooses these IDs. Valid only for the current question/investigation request; scope is sealed when the person presses Refine.',
    inputSchema: { roundId: identity, requestId: requestIdentity, scopeNets: z.array(z.string()), scopeSummary: z.string().min(1), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round_scope', mutates: true }, async (model, args) => {
    const { roundId, model: _model, ...body } = args;
    return ctx.client.masterApi('POST', path(model, roundId) + '/scope', body, { modelId: model });
  }));
  server.registerTool('focus_round_apply', {
    title: 'Apply model changes through the active Focus refinement',
    description: 'Make real definition/topology/organization/refinement/relation/level changes after the person presses Refine. Needs the current refinement requestId. operations use stable IDs and the same typed shapes as Focus proposals; the server checks the sealed scope, source fingerprints and shared ports and returns per-operation receipts. Repeated identical IDs keep successful edits. Call focus_rounds to inspect progress. This cannot edit files, activate transitions or delete runtime places.',
    inputSchema: { roundId: identity, requestId: requestIdentity, operations: z.array(z.record(z.unknown())).min(1).max(50), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round_apply', mutates: true }, async (model, args) => {
    const { roundId, model: _model, ...body } = args;
    return ctx.client.masterApi('POST', path(model, roundId) + '/apply', body, { modelId: model });
  }));
  server.registerTool('focus_round', {
    title: 'Start, answer, refine or resume a guided Focus round',
    description: 'One goal across its relevant layers, one adaptive multiple-choice question at a time (up to ten, free text accepted). start needs only a stable roundId and a plain-language topic. The headless agent discovers the relevant nets and layers; do not ask the person for a net or session. scope is optional for callers that already have an explicit boundary. answer saves a decision; unknown:true investigates evidence and returns a recommendation for the same decision. Only refine seals the answers and discovered scope, then generates, validates and directly applies definitions and topology. Successful edits survive partial failures; retry resumes unfinished work. Read focus_rounds for progress and the discovered model areas. Model context is staged as searchable files with headless-agent 1.1.0; a source repository is optional. Each new round must be requested by the person.',
    inputSchema: {
      action: z.enum(['start', 'answer', 'refine', 'retry']), roundId: identity,
      topic: z.string().min(1).optional(), scope: z.string().min(1).optional().describe('Optional explicit boundary; omit to let the headless agent discover the relevant areas from the topic'),
      profileId: z.enum(['claude-code-read-only', 'codex-read-only']).optional(),
      promptId: z.string().optional(), selected: z.array(z.string()).optional(), text: z.string().optional(),
      unknown: z.boolean().optional(), by: z.string().optional(), ...modelParam(ctx),
    },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round', mutates: true }, async (model, args) => {
    const { action, roundId, model: _model, ...input } = args;
    if (action === 'start' && !args.topic?.trim()) throw new Error('start requires a topic');
    const url = action === 'start' ? path(model) : path(model, roundId) + '/' + action;
    const body = action === 'start' ? { ...input, roundId } : action === 'answer' ? input : {};
    return ctx.client.masterApi('POST', url, body, { modelId: model });
  }));
}
