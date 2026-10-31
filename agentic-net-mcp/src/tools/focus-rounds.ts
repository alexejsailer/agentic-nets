import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { refinementCall, refinementPath, routeMissing } from './refinement-routes.js';

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
    description: 'List saved rounds, or read one round with its current question, saved answers and per-operation outcomes. Rounds a model kept from before the refinement became part of the core are listed with legacy:true until the first write copies them. Pending work resumes when read after a restart. Questions can also be answered with curate_model {action:"answer"}. Outside a running continuous programme (refinement_programme) no new round starts automatically; inside one, programme:true rounds carry their sequence, the decisions carried forward and the cards withdrawn after the previous refinement.',
    inputSchema: { roundId: identity.optional(), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_rounds', mutates: false }, async (model, args) =>
    refinementCall(ctx, 'GET', model, rounds(args.roundId))));
  server.registerTool('refine_balance', {
    title: 'How the levels carry the model: sizes, unexplained steps, hubs and findings',
    description: 'Deterministic read of the abstraction hierarchy (no AI): per level the nets, their element count and spread; per net its size, depth, children, fan-in/fan-out through shared places and the steps no net below explains; hub places; and findings: a level that carries more than the level below it (the top must be the smallest), an oversized net among its siblings, an upper net with unexplained steps, a place shared by many nets. Read it before proposing structure (restructure_model or round operations split/merge/abstract/move). level and scope narrow it.',
    inputSchema: { level: z.string().optional(), scope: z.string().optional().describe('A focus scope (domain:, tag:, net:)'), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'refine_balance', mutates: false }, async (model, args) => {
    try {
      return await refinementCall(ctx, 'GET', model, '/balance', undefined, { level: args.level, scope: args.scope });
    } catch (err: any) {
      if (routeMissing(err)) return { available: false, model, reason: 'route-missing', hint: 'This master predates the balance read.' };
      throw err;
    }
  }));
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
    description: 'Make real definition/topology/organization/refinement/relation/level changes, and structure changes (attach, detach, abstract, split, merge, promote, move with the arguments of restructure_model, the net as target "session::net", a new net as child "session::net"), after the person presses Refine. Needs the current refinement requestId. operations use stable IDs and the same typed shapes as the round\'s proposals; the server checks the sealed scope, source fingerprints and shared ports and returns per-operation receipts. Repeated identical IDs keep successful edits. Call focus_rounds to inspect progress. This cannot edit files, activate transitions or delete runtime places.',
    inputSchema: { roundId: identity, requestId: requestIdentity, operations: z.array(z.record(z.unknown())).min(1).max(50), ...modelParam(ctx) },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'focus_round_apply', mutates: true }, async (model, args) => {
    const { roundId, model: _model, ...body } = args;
    return refinementCall(ctx, 'POST', model, rounds(roundId) + '/apply', body);
  }));
  const netRef = z.object({ sessionId: z.string(), netId: z.string() });
  server.registerTool('restructure_model', {
    title: 'Restructure the abstraction levels: attach, detach, abstract, split, merge, promote or move a net',
    description: 'Structure operations on the hierarchy, outside a round (inside a round use the same kinds as focus_round_apply operations). '
      + 'attach {sessionId, netId, parent} puts an existing net below an element; detach {sessionId, netId} removes it from its parent element; '
      + 'abstract {sessionId, netId, elementId, child?} marks a step design-only and optionally attaches the net that explains it; '
      + 'split {sessionId, netId, elements, child, name, transitionId?, label?} moves named places and steps into a new net one level down, behind one new design-only step whose ports keep the same place ids; '
      + 'merge {sessionId, netId, elementId} replaces a refined step by the content of its net (that net is archived); '
      + 'promote {sessionId, netId, elementId, child, name?} turns an inline page into a persistent net; '
      + 'move {sessionId, netId, toSession, newNetId?} copies a net to another session, re-points parents, children and relations, and archives the original. '
      + 'Simpler from the bottom up: read refine_balance first. Steps that run (have an inscription) are never moved or removed: the bottom level is the asset. '
      + 'requestId makes a call repeat-safe: the same requestId continues an interrupted operation. Nothing is deleted.',
    inputSchema: {
      kind: z.enum(['attach', 'detach', 'abstract', 'split', 'merge', 'promote', 'move']), requestId: requestIdentity,
      sessionId: z.string(), netId: z.string(), elementId: z.string().optional(), elements: z.array(z.string()).min(1).max(200).optional(),
      child: netRef.optional().describe('split/promote: the new net; abstract: the net that explains the step'),
      name: z.string().optional(), description: z.string().optional(), label: z.string().optional(), transitionId: z.string().optional(),
      parent: z.object({ sessionId: z.string(), netId: z.string(), elementId: z.string(), elementType: z.enum(['transition', 'place']).optional() }).optional(),
      previousChild: netRef.optional(), toSession: z.string().optional(), newNetId: z.string().optional(), ...modelParam(ctx),
    },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'restructure_model', mutates: true }, async (model, args) => {
    const key = (r: { sessionId: string; netId: string }) => `${r.sessionId}::${r.netId}`;
    const body: Record<string, unknown> = { kind: args.kind, requestId: args.requestId, target: key({ sessionId: args.sessionId, netId: args.netId }) };
    for (const k of ['elementId', 'elements', 'name', 'description', 'label', 'transitionId', 'toSession'] as const) if (args[k] !== undefined) body[k] = args[k];
    if (args.child) body.child = key(args.child);
    if (args.previousChild) body.previousChild = key(args.previousChild);
    if (args.newNetId) body.netId = args.newNetId;
    if (args.parent) body.parent = { net: key(args.parent), elementId: args.parent.elementId, elementType: args.parent.elementType ?? 'transition' };
    try {
      return await ctx.client.masterApi('POST', refinementPath(model, '/structure'), body, { modelId: model });
    } catch (err: any) {
      if (routeMissing(err)) return { available: false, model, reason: 'route-missing', hint: 'This master predates the structure operations: use update_net_definition and add_transitions.' };
      throw err;
    }
  }));
  server.registerTool('refinement_programme', {
    title: 'Read or steer the model\'s refinement programme (continuous question rounds)',
    description: 'The programme is the model\'s standing refinement on one topic. In continuous mode, when the person presses Refine on a round, the next round\'s ten cards are prepared at once from what was decided, so they are ready while the AI applies the answers; cards whose net that refinement removed are withdrawn. state (default) reads it: topic, mode, state, its rounds, currentRound (the round to answer), nextReady, refining and suggestedFocus. start {topic, profileId?, scope?, mode?} starts or retargets it and makes sure a round is open; pause stops new card preparation (running work finishes); resume continues; stop also cancels rounds that only waited for their cards; topic changes the topic of the next round; use-focus takes the AI\'s suggestedFocus as the topic; mode {mode} switches continuous/manual. An unfinished refinement pauses the programme with its reason. Start, resume and topic changes only on the person\'s request.',
    inputSchema: {
      action: z.enum(['state', 'start', 'pause', 'resume', 'stop', 'topic', 'use-focus', 'mode']).default('state'),
      topic: z.string().min(1).max(2000).optional(), scope: z.string().min(1).optional().describe('Optional explicit boundary; omit to let the runner discover the areas'),
      profileId: z.string().min(1).max(100).optional().describe('Runner profile: claude-code-read-only (default), codex-read-only, platform-read-only or one added to the model'),
      mode: z.enum(['continuous', 'manual']).optional(), by: z.string().optional(), ...modelParam(ctx),
    },
  }, wrapTool(ctx.scope, ctx.config.mode, { name: 'refinement_programme', mutates: true }, async (model, args) => {
    const { action = 'state', model: _model, ...input } = args;
    try {
      return action === 'state'
        ? await ctx.client.masterApi('GET', `${refinementPath(model, '/programme')}?${new URLSearchParams({ modelId: model }).toString()}`)
        : await ctx.client.masterApi('POST', refinementPath(model, '/programme'), { action, ...input }, { modelId: model });
    } catch (err: any) {
      if (routeMissing(err)) return { available: false, model, reason: 'route-missing',
        hint: 'This master has no refinement programme (it predates it): start each round with focus_round {action:"start"}.' };
      throw err;
    }
  }));
  server.registerTool('focus_round', {
    title: 'Start, answer, refine layers, implement code or resume a refinement round',
    description: 'One goal across its relevant layers. A round is ten short multiple-choice cards prepared in one headless request, with exactly one recommended option each. The UI shows one card at a time; answering saves and advances without another agent run. Free text is accepted. start needs only a stable roundId and a plain-language topic. The headless agent discovers the relevant nets and layers; do not ask the person for a net or session. scope is optional for callers that already have an explicit boundary. answer saves a decision; unknown:true investigates evidence and returns a recommendation for the same decision, keeping the remaining cards. Follow-up rounds adapt to the saved answers after refinement. After all ten answers, refine updates model layers/nets with read-only source access. implement explicitly runs a write profile in the configured source folder, edits code, runs checks and returns a work report with executor-recorded file changes. Both seal the answers. A source folder is required for implement; never invoke it unless the person requested code implementation. Successful edits survive partial failures; retry resumes unfinished work. Read focus_rounds for progress and the discovered model areas. Model context is staged as searchable files; a source repository is optional. The refinement and its runner install themselves into the model on the first round. Each new round must be requested by the person, unless the person started a continuous programme (refinement_programme), which prepares the next round when a round is refined.',
    inputSchema: {
      action: z.enum(['start', 'answer', 'refine', 'implement', 'retry']), roundId: identity,
      topic: z.string().min(1).optional(), scope: z.string().min(1).optional().describe('Optional explicit boundary; omit to let the headless agent discover the relevant areas from the topic'),
      profileId: z.string().min(1).max(100).optional().describe('Runner profile: claude-code-read-only (default), codex-read-only, '
        + 'platform-read-only (the platform\'s own LLM: reads the model through MCP, cannot open source files), or one added to the model'),
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
