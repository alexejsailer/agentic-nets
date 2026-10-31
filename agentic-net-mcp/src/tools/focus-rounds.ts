import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { refinementCall } from './refinement-routes.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const requestIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
/** The rounds' sub-path under the refinement's routes (an older master serves it without /refinement). */
function rounds(id?: string): string {
  return `/rounds${id ? '/' + encodeURIComponent(id) : ''}`;
}
function modelParam(ctx: AppContext): Record<string, z.ZodTypeAny> {
  return ctx.scope.multiModel ? { model: z.string().optional().describe('Target model within this connection’s allowed models') } : {};
}
export function registerFocusRoundReaders(server: McpServer, ctx: AppContext): void {
  server.registerTool('focus_rounds', {
    title: 'Read the refinement\'s question rounds and their results',
    description: 'List saved rounds, or read one round with its current question, saved answers and per-operation outcomes. Rounds a model kept from before the refinement became part of the core are listed with legacy:true until the first write copies them. Pending work resumes when read after a restart. Questions can also be answered with curate_model {action:"answer"}. No new round starts automatically.',
    inputSchema: { roundId: identity.optional(), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_rounds', mutates: false }, async (model, args) =>
    refinementCall(ctx, 'GET', model, rounds(args.roundId))));
}
export function registerFocusRoundTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('focus_round_scope', {
    title: 'Register the areas discovered by the refinement runner',
    description: 'After searching the live model with explore_model and reading definitions, register the existing nets relevant to this goal across its layers. The person never chooses these IDs. Valid only for the current question/investigation request; scope is sealed when the person presses Refine.',
    inputSchema: { roundId: identity, requestId: requestIdentity, scopeNets: z.array(z.string()), scopeSummary: z.string().min(1), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round_scope', mutates: true }, async (model, args) => {
    const { roundId, model: _model, ...body } = args;
    return refinementCall(ctx, 'POST', model, rounds(roundId) + '/scope', body);
  }));
  server.registerTool('focus_round_apply', {
    title: 'Apply model changes through the active refinement round',
    description: 'Make real definition/topology/organization/refinement/relation/level changes after the person presses Refine. Needs the current refinement requestId. operations use stable IDs and the same typed shapes as the round\'s proposals; the server checks the sealed scope, source fingerprints and shared ports and returns per-operation receipts. Repeated identical IDs keep successful edits. Call focus_rounds to inspect progress. This cannot edit files, activate transitions or delete runtime places.',
    inputSchema: { roundId: identity, requestId: requestIdentity, operations: z.array(z.record(z.unknown())).min(1).max(50), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round_apply', mutates: true }, async (model, args) => {
    const { roundId, model: _model, ...body } = args;
    return refinementCall(ctx, 'POST', model, rounds(roundId) + '/apply', body);
  }));
  server.registerTool('focus_round', {
    title: 'Start, answer, refine layers, implement code or resume a refinement round',
    description: 'One goal across its relevant layers. A round is ten short multiple-choice cards prepared in one headless request, with exactly one recommended option each. The UI shows one card at a time; answering saves and advances without another agent run. Free text is accepted. start needs only a stable roundId and a plain-language topic. The headless agent discovers the relevant nets and layers; do not ask the person for a net or session. scope is optional for callers that already have an explicit boundary. answer saves a decision; unknown:true investigates evidence and returns a recommendation for the same decision, keeping the remaining cards. Follow-up rounds adapt to the saved answers after refinement. After all ten answers, refine updates model layers/nets with read-only source access. implement explicitly runs a write profile in the configured source folder, edits code, runs checks and returns a work report with executor-recorded file changes. Both seal the answers. A source folder is required for implement; never invoke it unless the person requested code implementation. Successful edits survive partial failures; retry resumes unfinished work. Read focus_rounds for progress and the discovered model areas. Model context is staged as searchable files; a source repository is optional. The refinement and its runner install themselves into the model on the first round. Each new round must be requested by the person.',
    inputSchema: {
      action: z.enum(['start', 'answer', 'refine', 'implement', 'retry']), roundId: identity,
      topic: z.string().min(1).optional(), scope: z.string().min(1).optional().describe('Optional explicit boundary; omit to let the headless agent discover the relevant areas from the topic'),
      profileId: z.enum(['claude-code-read-only', 'codex-read-only']).optional(),
      promptId: z.string().optional(), selected: z.array(z.string()).optional(), text: z.string().optional(),
      unknown: z.boolean().optional(), by: z.string().optional(), ...modelParam(ctx),
    },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round', mutates: true }, async (model, args) => {
    const { action, roundId, model: _model, ...input } = args;
    if (action === 'start' && !args.topic?.trim()) throw new Error('start requires a topic');
    const sub = action === 'start' ? rounds() : rounds(roundId) + '/' + action;
    const body = action === 'start' ? { ...input, roundId } : action === 'answer' ? input : {};
    return refinementCall(ctx, 'POST', model, sub, body);
  }));
}
