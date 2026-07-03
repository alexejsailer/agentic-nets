/**
 * Net-building layer — kind-aware, pre-wired construction (the Forge lesson:
 * never make the client LLM hand-author fragile inscriptions).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { agentFor, assignInscription, buildInscription, persistInscriptionLeaf } from '../inscriptions.js';
import { TemplateExecutor } from '../templates/executor.js';
import { TEMPLATES } from '../templates/index.js';
import { linkPlaces } from './memory.js';

export function registerNetTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'deploy_template',
    {
      title: 'Deploy a starter template',
      description:
        `Deploy a pre-built net into a model. Templates: ${Object.keys(TEMPLATES).join(', ')}. ` +
        'working-memory = the second-brain setup (memory places + nightly LLM distill + reaper); ' +
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
      await ctx.master.createNet({ modelId: model, sessionId: config.session, netId: args.netId, name: args.name ?? args.netId });
      return { created: args.netId, session: config.session };
    }),
  );

  server.registerTool(
    'add_place',
    {
      title: 'Add a place',
      description: 'Add a place to a net (designtime, for the GUI) AND as a runtime token container (so transitions can bind it).',
      inputSchema: {
        netId: z.string(),
        placeId: z.string().describe('Convention: p-<name>'),
        label: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'add_place', mutates: true }, async (model, args) => {
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
      if (!res.success) throw new Error(res.error ?? 'runtime place failed');
      return { place: args.placeId, designtime: true, runtime: true };
    }),
  );

  server.registerTool(
    'add_transition',
    {
      title: 'Add a transition (pre-wired by kind)',
      description:
        'Add a transition with a known-good inscription for its kind. Kinds: map (template transform), llm (one AI call: prompt template, optional model override), http (API call), command (executes command-shaped tokens on the executor), link (pure structure edge, never fires). Wires input/output arcs, assigns, and starts it (unless kind=link or start:false).',
      inputSchema: {
        netId: z.string(),
        transitionId: z.string().describe('Convention: t-<name>'),
        kind: z.enum(['map', 'llm', 'http', 'command', 'link']),
        inputPlace: z.string(),
        outputPlace: z.string(),
        label: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        prompt: z.string().optional().describe('llm: the instruction; ${input.data.field} interpolates token fields'),
        llmModel: z.string().optional().describe('llm: per-transition model override (e.g. glm-5.2:cloud)'),
        url: z.string().optional().describe('http: target URL (default ${input.data.url})'),
        method: z.string().optional().describe('http: default GET'),
        template: z.record(z.any()).optional().describe('map: the output template object'),
        scheduleCron: z.string().optional().describe('6-field cron — makes this a scheduled tick'),
        intervalMs: z.number().optional().describe('Alternative to cron: fixed interval'),
        timeoutMs: z.number().optional(),
        capacity: z.number().optional().describe('Output place capacity (backpressure)'),
        start: z.boolean().optional().describe('Default true (links are never started)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'add_transition', mutates: true }, async (model, args) => {
      const host = ctx.hostFor(model);
      const dup = (err: any) => {
        if (err?.name !== 'GatewayError' || (err.status !== 409 && err.status !== 422)) throw err;
      };
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

      const inscription = buildInscription(args.kind, {
        id: args.transitionId,
        label: args.label,
        host,
        inputPlace: args.inputPlace,
        outputPlace: args.outputPlace,
        prompt: args.prompt,
        llmModel: args.llmModel,
        url: args.url,
        method: args.method,
        template: args.template,
        scheduleCron: args.scheduleCron,
        intervalMs: args.intervalMs,
        timeoutMs: args.timeoutMs,
        capacity: args.capacity,
      });
      await assignInscription(ctx, model, inscription, agentFor(args.kind));
      await persistInscriptionLeaf(ctx, model, args.netId, args.transitionId, inscription);

      let started = false;
      if (args.kind !== 'link' && args.start !== false) {
        await ctx.master.startTransition(args.transitionId, model);
        started = true;
      }
      return { transition: args.transitionId, kind: args.kind, started, inscription };
    }),
  );

  server.registerTool(
    'set_schedule',
    {
      title: 'Set / change a transition schedule',
      description: 'Merge a cron or interval schedule into an existing transition and restart it (assign stops a transition — this handles the restart).',
      inputSchema: {
        transitionId: z.string(),
        scheduleCron: z.string().optional().describe('6-field cron'),
        intervalMs: z.number().optional(),
        netId: z.string().optional().describe('If given, the designtime inscription copy is updated too'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'set_schedule', mutates: true }, async (model, args) => {
      if (!args.scheduleCron && !args.intervalMs) throw new Error('provide scheduleCron or intervalMs');
      const kids = await ctx.node.getChildren(model, `root/workspace/transitions/${args.transitionId}`);
      const leaf = (kids ?? []).find((c: any) => c.name === 'inscription');
      const value = leaf?.properties?.value ?? leaf?.value;
      if (!value) throw new Error(`no inscription found for ${args.transitionId}`);
      const inscription = JSON.parse(value);
      inscription.schedule = args.scheduleCron
        ? { type: 'cron', cron: args.scheduleCron }
        : { type: 'interval', intervalMs: args.intervalMs };
      const agentId = inscription.kind === 'command' ? 'agentic-net-executor-default' : 'agentic-net-master';
      await assignInscription(ctx, model, inscription, agentId);
      if (args.netId) await persistInscriptionLeaf(ctx, model, args.netId, args.transitionId, inscription);
      await ctx.master.startTransition(args.transitionId, model);
      return { transition: args.transitionId, schedule: inscription.schedule, restarted: true };
    }),
  );

  for (const [name, tool, description] of [
    ['fire_once', 'FIRE_ONCE', 'Fire a transition once (manual trigger). 409 while RUNNING — stop it first.'],
    ['start_transition', 'START_TRANSITION', 'Start a transition (begins polling its input places).'],
    ['stop_transition', 'STOP_TRANSITION', 'Stop a transition (kill switch for any lane).'],
  ] as const) {
    server.registerTool(
      name,
      {
        title: description.split('(')[0].trim(),
        description,
        inputSchema: { transitionId: z.string(), ...modelParam },
      },
      wrapTool(scope, config.mode, { name, mutates: true }, async (model, args) => {
        const res = await ctx.executorFor(model).execute(tool, { transitionId: args.transitionId });
        if (!res.success) throw new Error(res.error ?? `${tool} failed`);
        return res.data ?? { ok: true };
      }),
    );
  }

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

  for (const [name, tool, description, mutates] of [
    [
      'scaffold_tool_net',
      'SCAFFOLD_TOOL_NET',
      'Crystallize a capability: scaffold a reusable tool-net (kind-aware: command/http/llm pipelines pre-wired, invoke-ready by construction).',
      true,
    ],
    [
      'invoke_tool_net',
      'INVOKE_TOOL_NET',
      'Invoke a tool-net from the library synchronously with an input object — deterministic reuse at zero LLM cost.',
      true,
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        title: description.split(':')[0],
        description,
        inputSchema: {
          params: z.record(z.any()).describe('Passthrough parameters for the underlying agent tool'),
          ...modelParam,
        },
      },
      wrapTool(scope, config.mode, { name, mutates }, async (model, args) => {
        const res = await ctx.executorFor(model).execute(tool, args.params ?? {});
        if (!res.success) throw new Error(res.error ?? `${tool} failed`);
        return res.data ?? { ok: true };
      }),
    );
  }
}
