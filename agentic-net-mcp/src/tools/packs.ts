/**
 * Whole-net install tools — design everything upfront, inject in ONE call.
 *
 * The compact net source (see `agenticnets://docs/net-source` and
 * capabilities/CONTRACT.md B1a) is compiled in-process by the shared
 * `@agenticos/cli/net/compile` and instantiated through the same native
 * primitives an interactive build would use. This is the tool-shaped form of
 * the capabilities workflow proven on 2026-08-29 (place-inspector: compiled
 * output deep-equal to a live-verified pack, reinstalled, smoke 4/4).
 *
 * Teaching stance (deliberate): TRY THIS FIRST when the user wants a new net —
 * author the full design, install once — then VERIFY with the normal tooling
 * (verify_inscription, fire_once, net_stats, injected smoke tokens). The
 * response's `verifyNext` block repeats that so clients don't skip it.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { compileNet, type CompactNetSource } from '@agenticos/cli/net/compile';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

/** Serialize-replace every owned id with id+suffix (longest first, word-bounded). */
function remap<T>(value: T, ids: Set<string>, suffix: string): T {
  if (!suffix) return value;
  let s = JSON.stringify(value);
  for (const id of [...ids].sort((a, b) => b.length - a.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replaceAll(new RegExp(`${escaped}(?![\\w-])`, 'g'), `${id}${suffix}`);
  }
  return JSON.parse(s);
}

/** Compile a source for STRUCTURAL purposes only (ids/topology) — agent prompts stubbed. */
function compileStructure(source: CompactNetSource, session?: string) {
  const stubbed: CompactNetSource = {
    ...source,
    transitions: (source.transitions ?? []).map((t) =>
      t.kind === 'agent' ? { ...t, agent: { ...(t.agent ?? {}), charter: undefined, nl: t.agent?.nl ?? 'structural-stub' } } : t,
    ),
  };
  return compileNet(stubbed, { session });
}

function ownedIds(compiled: ReturnType<typeof compileNet>): Set<string> {
  const ids = new Set<string>([compiled.net.id]);
  for (const p of Object.keys(compiled.net.places)) ids.add(p);
  for (const t of Object.keys(compiled.net.transitions)) ids.add(t);
  return ids;
}

export function registerPackTools(server: McpServer, ctx: AppContext): void {
  const config = ctx.config;
  const scope = ctx.scope;

  server.registerTool(
    'install_net',
    {
      title: 'Install a fully-designed net in one call',
      description:
        'Design the WHOLE net upfront — places, transitions, inscriptions, prompts — as a compact ' +
        'source object, and this tool compiles + instantiates it in one call: arcs, layout, preset/' +
        'postset boilerplate and default emits are derived; session, net, places (designtime AND ' +
        'runtime), transitions, inscriptions, seeds, optional agent-manifest and session tags are ' +
        'created; non-link transitions started. PREFER THIS over hand-wiring create_net/add_place/' +
        'add_transition when the design is known upfront. Source format: see agenticnets://docs/net-source ' +
        '(transitions carry alias->place `reads`/`writes`; map needs `template`, http needs `http.url` ' +
        'with ${master} substituted, agent needs `agent.nl` or `agent.charter` into the charters map). ' +
        'Idempotency: config seeds are SKIPPED when the place already holds tokens; an existing ' +
        'agent-manifest leaf is replaced. Place ids are MODEL-GLOBAL — pass `suffix` to avoid ' +
        'collisions when installing a second copy. After installing, ALWAYS verify with the normal ' +
        'tooling — the response tells you how.',
      inputSchema: {
        source: z.record(z.any()).describe('The compact net source object (net, places, transitions[])'),
        charters: z
          .record(z.string())
          .optional()
          .describe('Charter name -> markdown prompt content, resolving agent.charter references'),
        seeds: z
          .record(z.array(z.record(z.any())))
          .optional()
          .describe('placeId -> seed tokens (config/policy/routing). Skipped per-place when non-empty.'),
        manifest: z
          .record(z.any())
          .optional()
          .describe('agent-manifest for the session (entry inbox/outbox contract) — makes the net a discoverable capability pack'),
        tags: z
          .array(z.string())
          .optional()
          .describe("Session tags; use ['agents','capability-pack'] for find_capabilities discovery"),
        session: z.string().optional().describe('Target session id (default: agent-<netId>)'),
        suffix: z.string().optional().describe('Appended to every owned net/place/transition id (collision-free copies)'),
        start: z.boolean().optional().describe('Start the transitions after install (default true)'),
        ...(scope.multiModel
          ? { model: z.string().optional().describe('Target model (default: the connection default; validated against the allowlist)') }
          : {}),
      },
    },
    wrapTool(scope, config.mode, { name: 'install_net', mutates: true }, async (model, args) => {
      const suffix = String(args.suffix ?? '');
      const compiledRaw = compileNet(args.source as CompactNetSource, {
        charters: args.charters,
        session: args.session,
      });
      const ids = ownedIds(compiledRaw);
      const session = `${args.session ?? (args.source as CompactNetSource).session ?? `agent-${compiledRaw.net.id}`}`;
      const compiled = remap(compiledRaw, ids, suffix);
      const netId = compiled.net.id;
      const ex = ctx.executorFor(model);
      const call = async (tool: string, params: Record<string, unknown>) => {
        const res = await ex.execute(tool as any, params);
        if (res && res.success === false) throw new Error(`${tool}: ${res.error ?? 'failed'}`);
        return res?.data;
      };

      await ex.execute('CREATE_SESSION' as any, {
        sessionId: session,
        naturalLanguageText: `install_net of ${netId}`,
      }); // tolerant: session may exist

      await call('CREATE_NET', { netId, name: netId, sessionId: session });
      for (const p of Object.values(compiled.net.places)) {
        await call('CREATE_PLACE', { netId, placeId: p.id, label: p.label, x: p.x, y: p.y, sessionId: session });
        await call('CREATE_RUNTIME_PLACE', { placeId: p.id });
      }
      for (const t of Object.values(compiled.net.transitions)) {
        await call('CREATE_TRANSITION', { netId, transitionId: t.id, label: t.label, x: t.x, y: t.y, sessionId: session });
      }
      for (const a of Object.values(compiled.net.arcs)) {
        await call('CREATE_ARC', { netId, arcId: a.id, sourceId: a.source, targetId: a.target, sessionId: session });
      }

      const started: string[] = [];
      for (const raw of compiled.inscriptions) {
        const i: any = raw;
        i.metadata = { ...(i.metadata ?? {}), sessionId: session };
        if (i.action?.sessionId) i.action.sessionId = session;
        // Normalize to the TARGET model + this deployment's node host so the same
        // source installs anywhere (staging, compose, Desktop).
        const nodeHost = config.nodeHost;
        for (const set of [i.presets ?? {}, i.postsets ?? {}])
          for (const slot of Object.values(set) as any[]) if (slot.host) slot.host = `${model}@${nodeHost}`;
        if (i.action?.type === 'agent') i.action.modelId = model;
        await call('SET_INSCRIPTION', { transitionId: i.id, inscription: i });
        if (i.kind !== 'link') started.push(i.id);
      }

      const seeded: string[] = [];
      const skippedSeeds: string[] = [];
      for (const [placeRaw, tokens] of Object.entries(args.seeds ?? {})) {
        const place = remap(placeRaw, ids, suffix);
        const existing: any = await ex.execute('QUERY_TOKENS' as any, {
          placePath: `root/workspace/places/${place}`,
          arcql: 'FROM $ LIMIT 1',
        });
        const count =
          existing?.data?.results?.length ?? existing?.data?.tokens?.length ?? (Array.isArray(existing?.data) ? existing.data.length : 0);
        if (count > 0) {
          skippedSeeds.push(place); // never blind-reseed (capabilities CONTRACT C4)
          continue;
        }
        for (const tok of tokens as any[]) {
          await call('CREATE_TOKEN', { placePath: `root/workspace/places/${place}`, data: tok });
        }
        seeded.push(place);
      }

      if (args.manifest) {
        const manifest = remap({ ...args.manifest }, ids, suffix) as any;
        manifest.sessionId = session;
        await ex.execute('DELETE_TOKEN' as any, {
          placePath: `root/workspace/sessions/${session}`,
          tokenName: 'agent-manifest',
        }); // tolerant: replace, don't blind-create
        await call('CREATE_TOKEN', {
          placePath: `root/workspace/sessions/${session}`,
          name: 'agent-manifest',
          data: { value: JSON.stringify(manifest) },
        });
      }
      if (args.tags?.length) {
        await call('TAG_SESSION', { sessionId: session, tags: args.tags, mode: 'add' });
      }
      if (args.start !== false) {
        for (const tid of started) await call('START_TRANSITION', { transitionId: tid });
      }

      return {
        installed: {
          netId,
          session,
          places: Object.keys(compiled.net.places).length,
          transitions: Object.keys(compiled.net.transitions).length,
          arcs: Object.keys(compiled.net.arcs).length,
          started: args.start !== false ? started.length : 0,
          seeded,
          ...(skippedSeeds.length ? { skippedSeeds } : {}),
          manifest: Boolean(args.manifest),
          tags: args.tags ?? [],
        },
        verifyNext:
          'Now verify with the normal tooling before trusting it: verify_inscription on each lane, ' +
          'then inject one real token into the entry place and watch it traverse (query_tokens on the ' +
          'outbox, event_trail on a transition), or fire_once a deterministic lane. net_stats shows ' +
          'errors + executor coverage. An install that was never smoked is a design, not a capability.',
      };
    }),
  );

  server.registerTool(
    'uninstall_net',
    {
      title: 'Uninstall a net installed from a compact source',
      description:
        'Reverse of install_net: stops + deregisters the net\'s transitions, deletes the net, and ' +
        'optionally removes the session tags. Deliberately conservative: runtime places, their ' +
        'tokens, the session node and the agent-manifest leaf all REMAIN (a re-install replaces ' +
        'the manifest and skips still-seeded config places). Pass the same source (+suffix) the ' +
        'net was installed from.',
      inputSchema: {
        source: z.record(z.any()).describe('The compact net source the install used'),
        session: z.string().optional().describe('Session id (default: agent-<netId>)'),
        suffix: z.string().optional(),
        untag: z.array(z.string()).optional().describe('Tags to remove from the session (e.g. discovery tags)'),
        ...(scope.multiModel ? { model: z.string().optional().describe('Target model') } : {}),
      },
    },
    wrapTool(
      scope,
      config.mode,
      { name: 'uninstall_net', mutates: true, destructive: true },
      async (model, args) => {
        const suffix = String(args.suffix ?? '');
        const structural = compileStructure(args.source as CompactNetSource, args.session);
        const compiled = remap(structural, ownedIds(structural), suffix);
        const session = `${args.session ?? (args.source as CompactNetSource).session ?? `agent-${(args.source as CompactNetSource).net}`}`;
        const ex = ctx.executorFor(model);
        const removed: string[] = [];
        for (const i of compiled.inscriptions as any[]) {
          await ex.execute('STOP_TRANSITION' as any, { transitionId: i.id });
          await ex.execute('DELETE_TRANSITION' as any, { transitionId: i.id });
          removed.push(i.id);
        }
        await ex.execute('DELETE_NET' as any, {
          netId: compiled.net.id,
          sessionId: session,
          deleteTransitions: true,
        });
        if (args.untag?.length) {
          await ex.execute('TAG_SESSION' as any, { sessionId: session, tags: args.untag, mode: 'remove' });
        }
        return {
          uninstalled: { netId: compiled.net.id, session, transitionsRemoved: removed.length },
          note: 'Runtime places, tokens, the session node and the agent-manifest leaf remain by design.',
        };
      },
    ),
  );
}
