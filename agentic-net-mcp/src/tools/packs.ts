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
import { StructuredToolError, wrapTool } from '../scope.js';

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

function ownedIds(compiled: ReturnType<typeof compileNet>, external: Set<string> = new Set()): Set<string> {
  const ids = new Set<string>([compiled.net.id]);
  for (const p of Object.keys(compiled.net.places)) if (!external.has(p)) ids.add(p);
  for (const t of Object.keys(compiled.net.transitions)) ids.add(t);
  return ids;
}

/**
 * Places the source declares as belonging to ANOTHER net (a shared boundary): either
 * `places: {id: {external: true}}` or a top-level `externalPlaces: [ids]`. The compiler ignores
 * both keys, so its output stays byte-stable; the installer draws such a place and ensures its
 * runtime node, but never renames it under `suffix` and never seeds it.
 */
export function externalPlaceIds(source: any): Set<string> {
  const out = new Set<string>();
  for (const [id, meta] of Object.entries(source?.places ?? {})) {
    if (meta && typeof meta === 'object' && (meta as any).external === true) out.add(id);
  }
  for (const id of Array.isArray(source?.externalPlaces) ? source.externalPlaces : []) {
    if (typeof id === 'string' && id) out.add(id);
  }
  return out;
}

const RUNNING = new Set(['RUNNING', 'STARTING']);

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
        'collisions when installing a second copy. A place owned by ANOTHER net (a shared boundary) is ' +
        'declared with places:{id:{external:true}} or externalPlaces:[ids]: it is drawn and its runtime node ' +
        'ensured, never renamed by suffix, never seeded. start:false installs stopped and returns `startable` ' +
        '(the lanes it would have started). A lane that already exists and is RUNNING is stopped before its ' +
        'inscription is replaced (reported in `stopped`). A failure mid-install returns `progress` ' +
        '{created, failedAt} so you can reconcile instead of re-running blindly. After installing, ALWAYS ' +
        'verify with the normal tooling — the response tells you how.',
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
      const external = externalPlaceIds(args.source);
      const ids = ownedIds(compiledRaw, external);
      const session = `${args.session ?? (args.source as CompactNetSource).session ?? `agent-${compiledRaw.net.id}`}`;
      const compiled = remap(compiledRaw, ids, suffix);
      const netId = compiled.net.id;
      const ex = ctx.executorFor(model);

      // What has been written so far, so a failure can be reconciled instead of blindly re-run.
      const created = {
        session: false as boolean,
        net: false as boolean,
        places: [] as string[],
        runtimePlaces: [] as string[],
        transitions: [] as string[],
        arcs: [] as string[],
        inscriptions: [] as string[],
        seeded: [] as string[],
        stopped: [] as string[],
        started: [] as string[],
      };
      let step = 'compile';
      const call = async (tool: string, params: Record<string, unknown>) => {
        const res = await ex.execute(tool as any, params);
        if (res && res.success === false) throw new Error(`${tool}: ${res.error ?? 'failed'}`);
        return res?.data;
      };

      const run = async () => {
        step = `CREATE_SESSION ${session}`;
        await ex.execute('CREATE_SESSION' as any, {
          sessionId: session,
          naturalLanguageText: `install_net of ${netId}`,
        }); // tolerant: session may exist
        created.session = true;

        step = `CREATE_NET ${netId}`;
        await call('CREATE_NET', { netId, name: netId, sessionId: session });
        created.net = true;
        for (const p of Object.values(compiled.net.places)) {
          step = `CREATE_PLACE ${p.id}`;
          await call('CREATE_PLACE', { netId, placeId: p.id, label: p.label, x: p.x, y: p.y, sessionId: session });
          created.places.push(p.id);
          // Idempotent ensure: an existing runtime place (an external boundary above all) keeps its tokens.
          step = `CREATE_RUNTIME_PLACE ${p.id}`;
          await call('CREATE_RUNTIME_PLACE', { placeId: p.id });
          created.runtimePlaces.push(p.id);
        }
        for (const t of Object.values(compiled.net.transitions)) {
          step = `CREATE_TRANSITION ${t.id}`;
          await call('CREATE_TRANSITION', { netId, transitionId: t.id, label: t.label, x: t.x, y: t.y, sessionId: session });
          created.transitions.push(t.id);
        }
        for (const a of Object.values(compiled.net.arcs)) {
          step = `CREATE_ARC ${a.id}`;
          await call('CREATE_ARC', { netId, arcId: a.id, sourceId: a.source, targetId: a.target, sessionId: session });
          created.arcs.push(a.id);
        }

        const startable: string[] = [];
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
          // Changed-inscription rule (as add_transition): a RUNNING lane is stopped before its
          // inscription is swapped, so it never fires a half-replaced definition.
          step = `STATUS ${i.id}`;
          const prior: any = await ctx.client
            .masterApi('GET', `/transitions/${encodeURIComponent(String(i.id))}/status`, undefined, { modelId: model })
            .catch(() => null);
          const priorStatus = String(prior?.status ?? prior?.state ?? '').toUpperCase();
          if (RUNNING.has(priorStatus)) {
            step = `STOP_TRANSITION ${i.id}`;
            await call('STOP_TRANSITION', { transitionId: i.id });
            created.stopped.push(i.id);
          }
          step = `SET_INSCRIPTION ${i.id}`;
          await call('SET_INSCRIPTION', { transitionId: i.id, inscription: i });
          created.inscriptions.push(i.id);
          if (i.kind !== 'link') startable.push(i.id);
        }

        const skippedSeeds: string[] = [];
        const externalSeedsSkipped: string[] = [];
        for (const [placeRaw, tokens] of Object.entries(args.seeds ?? {})) {
          const place = remap(placeRaw, ids, suffix);
          if (external.has(place)) {
            externalSeedsSkipped.push(place); // another net owns it: never seeded from here
            continue;
          }
          step = `QUERY_TOKENS ${place}`;
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
            step = `CREATE_TOKEN ${place}`;
            await call('CREATE_TOKEN', { placePath: `root/workspace/places/${place}`, data: tok });
          }
          created.seeded.push(place);
        }

        if (args.manifest) {
          const manifest = remap({ ...args.manifest }, ids, suffix) as any;
          manifest.sessionId = session;
          step = `MANIFEST ${session}`;
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
          step = `TAG_SESSION ${session}`;
          await call('TAG_SESSION', { sessionId: session, tags: args.tags, mode: 'add' });
        }
        if (args.start !== false) {
          for (const tid of startable) {
            step = `START_TRANSITION ${tid}`;
            await call('START_TRANSITION', { transitionId: tid });
            created.started.push(tid);
          }
        }

        return {
          installed: {
            netId,
            session,
            places: Object.keys(compiled.net.places).length,
            transitions: Object.keys(compiled.net.transitions).length,
            arcs: Object.keys(compiled.net.arcs).length,
            started: args.start !== false ? startable.length : 0,
            ...(args.start === false ? { startable } : {}),
            seeded: created.seeded,
            ...(skippedSeeds.length ? { skippedSeeds } : {}),
            ...(external.size ? { externalPlaces: [...external] } : {}),
            ...(externalSeedsSkipped.length ? { externalSeedsSkipped } : {}),
            ...(created.stopped.length ? { stopped: created.stopped } : {}),
            manifest: Boolean(args.manifest),
            tags: args.tags ?? [],
          },
          verifyNext:
            'Now verify with the normal tooling before trusting it: verify_inscription on each lane, ' +
            'then inject one real token into the entry place and watch it traverse (query_tokens on the ' +
            'outbox, event_trail on a transition), or fire_once a deterministic lane. net_stats shows ' +
            'errors + executor coverage. An install that was never smoked is a design, not a capability.',
        };
      };

      try {
        return await run();
      } catch (err: any) {
        if (err instanceof StructuredToolError) throw err;
        throw new StructuredToolError({
          code: 'install-incomplete',
          error: String(err?.message ?? err),
          progress: { created, failedAt: step },
          hint: 'Nothing was rolled back. Reread the net (net_overview / sync_net) and re-run install_net with the '
            + 'same source: creates converge on existing elements, seeds are skipped where tokens exist, and '
            + 'stopped lanes stay stopped until you start them.',
        });
      }
    }),
  );

  server.registerTool(
    'uninstall_net',
    {
      title: 'Uninstall a net installed from a compact source',
      description:
        'Reverse of install_net: stops + deregisters the net\'s transitions, deletes the net, and ' +
        'removes the discovery tags so the dismantled pack stops being advertised by ' +
        'find_capabilities (its transitions are GONE, so a listed entry contract would be a lie — ' +
        'pass untag:[] to keep it listed deliberately). Deliberately conservative otherwise: ' +
        'runtime places, their tokens, the session node and the agent-manifest leaf all REMAIN, so ' +
        'a re-install is an upgrade rather than a reset. Pass the same source (+suffix) the net was ' +
        'installed from.',
      inputSchema: {
        source: z.record(z.any()).describe('The compact net source the install used'),
        session: z.string().optional().describe('Session id (default: agent-<netId>)'),
        suffix: z.string().optional(),
        untag: z
          .array(z.string())
          .optional()
          .describe("Tags to remove (default ['agents','capability-pack'] — the discovery tags). Pass [] to leave tags untouched."),
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
        const compiled = remap(structural, ownedIds(structural, externalPlaceIds(args.source)), suffix);
        const session = `${args.session ?? (args.source as CompactNetSource).session ?? `agent-${(args.source as CompactNetSource).net}`}`;
        const ex = ctx.executorFor(model);
        // Teardown must be IDEMPOTENT: an element already gone (partial earlier uninstall,
        // manual cleanup, a crash mid-run) must not abort the rest — otherwise a half-removed
        // pack can never be cleaned up, and the untag below would be unreachable.
        const tolerate = async (tool: string, params: Record<string, unknown>) => {
          try {
            const res: any = await ex.execute(tool as any, params);
            return res?.success !== false;
          } catch {
            return false;
          }
        };
        const removed: string[] = [];
        const alreadyGone: string[] = [];
        for (const i of compiled.inscriptions as any[]) {
          await tolerate('STOP_TRANSITION', { transitionId: i.id });
          (await tolerate('DELETE_TRANSITION', { transitionId: i.id }) ? removed : alreadyGone).push(i.id);
        }
        const netDeleted = await tolerate('DELETE_NET', {
          netId: compiled.net.id,
          sessionId: session,
          deleteTransitions: true,
        });
        // Default to removing the discovery tags: a pack whose transitions were just deleted must
        // not keep advertising an entry contract nothing can serve (delegate would refuse it, and
        // its "start it first" advice would be unfollowable). untag:[] opts out deliberately.
        const untag = args.untag ?? ['agents', 'capability-pack'];
        if (untag.length) {
          await tolerate('TAG_SESSION', { sessionId: session, tags: untag, mode: 'remove' });
        }
        return {
          uninstalled: {
            netId: compiled.net.id,
            session,
            transitionsRemoved: removed.length,
            ...(alreadyGone.length ? { alreadyAbsent: alreadyGone.length } : {}),
            netDeleted,
            untagged: untag,
          },
          note:
            'Runtime places, tokens, the session node and the agent-manifest leaf remain by design ' +
            '(re-install = upgrade, not reset).',
        };
      },
    ),
  );
}
