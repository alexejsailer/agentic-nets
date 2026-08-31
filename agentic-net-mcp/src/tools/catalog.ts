/**
 * Native tool catalog — FULL platform parity.
 *
 * Registers every tool the Agentic-Nets ToolExecutor implements (the same
 * catalog agent transitions use in-net) as a first-class MCP tool under its
 * canonical UPPERCASE name. The set and the schemas come straight from the
 * CLI's role registry (`getAvailableTools(ALL)` + `buildToolSchemas`), so new
 * platform tools appear here automatically on the next CLI sync — no MCP code
 * change needed.
 *
 * Division of labor with the curated lowercase tools: lowercase = the
 * ergonomic layer (pre-wired inscriptions, session fallbacks, engine gotchas
 * absorbed); UPPERCASE = raw native power (structure surgery, deletes,
 * packages, Docker/registry, NET_DOCTOR, exports, …). Same names as in-net
 * agent prompts, so knowledge transfers 1:1 between MCP clients and personas.
 *
 * Excluded: THINK / DONE / FAIL — agent-loop control primitives with no
 * meaning as stateless MCP calls. rw mode only: many native reads travel as
 * POST, which the readonly gateway scope rejects — readonly keeps the curated
 * GET-safe readers instead of advertising tools that would 403.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ALL, getAvailableTools } from '@agenticos/cli/agent/roles';
import { buildToolSchemas, type ToolSchema } from '@agenticos/cli/agent/tools';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

const AGENT_LOOP_ONLY = new Set(['THINK', 'DONE', 'FAIL']);

/**
 * Native tools that only READ (no state change) — drives truthful
 * readOnlyHint annotations instead of the old blanket mutates:true. Names not
 * matched here are treated as mutating (the safe default for an unknown tool).
 * TOOLNET_HEALTH is deliberately NOT read-only: active=true runs a live smoke
 * fire. COLLECT_RESULTS deletes correlated result tokens (self-cleaning).
 */
const READ_ONLY_NATIVE =
  /^(GET_|LIST_|QUERY_|DESCRIBE_|FIND_|INSPECT_|EXTRACT_|SEARCH_|EXPORT_|VERIFY_|DRY_RUN_|DIAGNOSE_|OBSERVE_|REGISTRY_|AWAIT_)/;
const READ_ONLY_EXTRA = new Set(['NET_DOCTOR', 'HUB_CATALOG', 'HUB_REMOTE_LIST', 'READ_BLOB_TEXT', 'TOOLNET_CANDIDATES', 'DOCKER_LIST', 'DOCKER_LOGS', 'TOOL_CATALOG_GET', 'TOOL_CATALOG_SEARCH', 'AGENT_HUB_SEARCH', 'CONTEXT_HUB_SEARCH']);
/** Irreversible data removal — surfaces as destructiveHint via the annotation stamp. */
const DESTRUCTIVE_NATIVE = /^(DELETE_|HUB_UNPUBLISH)/;

/**
 * Tools that reach OUTSIDE this deployment: an arbitrary URL, a peer hub, a container registry,
 * or a shell on the executor. Surfaces as `openWorldHint`, and switches the gateway-error advice
 * to remote-shaped wording — a 404 from someone else's web server must not be answered with
 * "verify with list_models / net_overview", which sends a client hunting through its own model
 * for a page that was never there.
 */
const OPEN_WORLD_NATIVE = new Set([
  'HTTP_CALL',
  'HUB_REMOTE_ADD', 'HUB_REMOTE_LIST', 'HUB_REMOTE_REMOVE',
  'REGISTRY_LIST_IMAGES', 'REGISTRY_GET_IMAGE_INFO', 'TOOL_CATALOG_IMPORT_IMAGE',
  'DOCKER_RUN', 'DOCKER_STOP', 'DOCKER_LIST', 'DOCKER_LOGS', 'WRAP_DOCKER_TOOL',
  'AGENT_HUB_SEARCH', 'CONTEXT_HUB_SEARCH',
]);

export function isNativeReadOnly(name: string): boolean {
  return READ_ONLY_NATIVE.test(name) || READ_ONLY_EXTRA.has(name);
}

export function isNativeOpenWorld(name: string): boolean {
  return OPEN_WORLD_NATIVE.has(name);
}

/**
 * Appended guidance for tools whose NAME or default output invites misreading
 * (protocol-hardening trap #5: a misleading name forecloses the search — the
 * description must point at the tool that actually answers the question).
 */
const DESCRIPTION_NOTES: Record<string, string> = {
  GET_SESSION_OVERVIEW:
    ' SCOPE WARNING: counts here are for ONE session, not the model — a fresh session reads netCount:0 even when the model is full. For the model-wide picture use net_overview (it adds modelSessionCount) or LIST_ALL_SESSIONS.',
  EXPORT_PNML:
    ' NOTE: designtime `tokens` counts in the export are FROZEN at design time (typically 0 forever) — they are NOT live marking. Read live tokens with query_tokens.',
  DEPLOY_TRANSITION:
    ' The response reports assigned:true and the resolved agentId — if no inscription is stored it fails loudly instead of "succeeding" without effect.',
};

/** The full native catalog as Anthropic-style schemas (name/description/input_schema). */
export function nativeCatalog(): ToolSchema[] {
  // Docker/registry tools (container spawning) are included by default for parity,
  // but deployments can withhold the grant with AGENTICOS_DOCKER_TOOLS=false —
  // mirroring the master's dedicated D capability flag instead of folding
  // container power into plain read/execute.
  const dockerGranted = process.env.AGENTICOS_DOCKER_TOOLS !== 'false';
  return buildToolSchemas(getAvailableTools({ ...ALL, docker: dockerGranted }))
    .filter((t) => !AGENT_LOOP_ONLY.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Shallow JSON-schema property → zod, keeping description + optionality (enough for discovery). */
function propToZod(prop: any, required: boolean): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  if (Array.isArray(prop?.enum) && prop.enum.length) {
    t = z.enum(prop.enum.map(String) as [string, ...string[]]);
  } else {
    switch (prop?.type) {
      case 'string':
        t = z.string();
        break;
      case 'integer':
      case 'number':
        t = z.number();
        break;
      case 'boolean':
        t = z.boolean();
        break;
      case 'array':
        t = z.array(z.any());
        break;
      case 'object':
        t = z.record(z.any());
        break;
      default:
        t = z.any();
    }
  }
  if (prop?.description) t = t.describe(String(prop.description));
  return required ? t : t.optional();
}

export function registerCatalogTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  if (config.mode === 'readonly') return;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  for (const tool of nativeCatalog()) {
    const shape: Record<string, z.ZodTypeAny> = { ...modelParam };
    const required = new Set(tool.input_schema?.required ?? []);
    // A native tool that declares its own `model` property (the tool-catalog scope param) has it
    // subsumed by the MCP scope param: the model the call routes to IS the catalog scope. Always
    // drop the native `model` from the advertised schema so it never appears twice (or at all in
    // single-model mode), and re-inject the resolved model as scope in the handler below.
    const declaresModelScope = 'model' in (tool.input_schema?.properties ?? {});
    const props = tool.input_schema?.properties ?? {};
    // Native token/place tools name their target `placePath`, but the ToolExecutor handler already
    // accepts `placeId`/`place` as aliases — and `placePath` actually wants the SHORT place id
    // (`p-input`), not a slash path. Advertise `placeId` and drop `placePath` from `required` so an
    // MCP caller can pass the same `placeId` the curated tools take, instead of being rejected by
    // schema validation before the handler's alias logic ever runs.
    const hasPlacePath = 'placePath' in props;
    if (hasPlacePath) required.delete('placePath');
    for (const [key, prop] of Object.entries(props)) {
      if (key === 'model') continue;
      shape[key] = propToZod(prop, required.has(key));
    }
    if (hasPlacePath && !('placeId' in props)) {
      shape.placeId = z
        .string()
        .optional()
        .describe('Alias for placePath — the short place id (e.g. p-input) works for either.');
    }
    server.registerTool(
      tool.name,
      {
        title: `${tool.name} (native)`,
        description: tool.description + (DESCRIPTION_NOTES[tool.name] ?? ''),
        inputSchema: shape,
      },
      wrapTool(
        scope,
        config.mode,
        {
          name: tool.name,
          mutates: !isNativeReadOnly(tool.name),
          destructive: DESTRUCTIVE_NATIVE.test(tool.name),
          openWorld: isNativeOpenWorld(tool.name),
        },
        async (model, args) => {
        const { model: _m, ...params } = args ?? {};
        // Catalog-scope tools resolve local-first against the routed model.
        const res = await ctx.executorFor(model).execute(
          tool.name as any,
          declaresModelScope ? { ...params, model } : params,
        );
        if (!res.success) throw new Error(res.error ?? `${tool.name} failed`);
        return res.data ?? { ok: true };
      }),
    );
  }
}

/**
 * test_script — run a registered script ONCE on the executor without wiring a lane.
 *
 * Registering a script is a blob write; whether it actually runs is only discovered when some
 * transition fires it, which meant authoring a pack or a net just to find out that argv was
 * wrong. This builds a throwaway command lane, fires it, returns stdout, and tears the lane
 * down again in a finally — a failed run must not leave debris behind for someone to find
 * later and wonder about.
 */
export function registerScriptDryRun(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  // Mutating: it creates a place and a transition and fires it. Readonly must never see it —
  // the gateway would refuse the writes anyway, but advertising it there is a false promise.
  if (config.mode === 'readonly') return;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'test_script',
    {
      title: 'Dry-run a cataloged script',
      description:
        'Run a script from the tool catalog ONCE on the executor and return its stdout, without creating a permanent lane. ' +
        'Use it to check a script actually runs — and that its env/argv contract is right — before wiring it into a net or shipping it in a capability pack. ' +
        'Creates a temporary place + command transition, fires once, and deletes both afterwards even if the run fails. ' +
        'The script resolves local-first in the target model, exactly as it would at fire time.',
      inputSchema: {
        toolId: z.string().describe('Catalog id of the script, e.g. scout-fetch'),
        env: z.record(z.string()).optional().describe('Environment for the run — the injection-safe way to pass dynamic input'),
        argv: z.array(z.string()).optional(),
        timeoutMs: z.number().optional().describe('Default 120000'),
        waitMs: z.number().optional().describe('How long to wait for the executor result (default 90000)'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'test_script', mutates: true }, async (model, args) => {
      const exec = ctx.executorFor(model);
      const run = async (tool: string, params: Record<string, unknown>) => {
        const res = await exec.execute(tool as any, params);
        if (!res.success) throw new Error(`${tool}: ${res.error ?? 'failed'}`);
        return res.data as any;
      };

      const sfx = Math.random().toString(36).slice(2, 8);
      const cmdPlace = `p-scripttest-cmd-${sfx}`;
      const outPlace = `p-scripttest-out-${sfx}`;
      const tid = `t-scripttest-${sfx}`;
      const timeoutMs = Number(args.timeoutMs ?? 120000);
      const waitMs = Number(args.waitMs ?? 90000);
      const created: string[] = [];
      let transitionCreated = false;

      try {
        await run('CREATE_RUNTIME_PLACE', { placeId: cmdPlace, model });
        created.push(cmdPlace);
        await run('CREATE_RUNTIME_PLACE', { placeId: outPlace, model });
        created.push(outPlace);

        await run('SET_INSCRIPTION', {
          transitionId: tid,
          model,
          inscription: {
            id: tid,
            kind: 'command',
            label: `dry-run ${args.toolId}`,
            mode: 'SINGLE',
            presets: { input: { placeId: cmdPlace, host: `${model}@${config.nodeHost}`, arcql: 'FROM $ LIMIT 1', take: 'FIRST', consume: true } },
            postsets: { log: { placeId: outPlace, host: `${model}@${config.nodeHost}` } },
            action: { type: 'command', inputPlace: 'input', groupBy: 'executor', dispatch: [{ executor: 'bash', channel: 'default' }], await: 'ALL', timeoutMs },
            emit: [{ to: 'log', from: '@result' }],
          },
        });
        transitionCreated = true;
        // SET_INSCRIPTION writes the config; it does not assign the lane to an executor.
        // Firing an unassigned command lane 409s, so deploy before the token goes in.
        await run('DEPLOY_TRANSITION', { transitionId: tid, model });

        await run('CREATE_TOKEN', {
          placeId: cmdPlace,
          model,
          data: {
            kind: 'command', id: `dryrun-${sfx}`, executor: 'script', command: 'invoke', expect: 'text',
            args: { toolId: args.toolId, argv: args.argv ?? [], env: args.env ?? {}, timeoutMs },
          },
        });

        await run('FIRE_ONCE', { transitionId: tid, model });

        // Command lanes are async: the executor has to poll, run, and report back.
        const deadline = Date.now() + waitMs;
        let result: any = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const q = await run('QUERY_TOKENS', { placeId: outPlace, model, arcql: 'FROM $ LIMIT 1', maxValueLength: 200000 });
          const rows = q?.results ?? q?.tokens ?? [];
          if (rows.length) { result = rows[0]?.data ?? rows[0]; break; }
        }
        if (!result) {
          return { toolId: args.toolId, ran: false, timedOut: true, waitedMs: waitMs,
            hint: 'No result within the wait window. Check an executor is ONLINE and polling this model (list_executors), and that the script runtime exists on that host.' };
        }

        let parsed = result.parsedStdout;
        if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { /* leave as text */ } }
        return {
          toolId: args.toolId,
          ran: true,
          success: result.success ?? null,
          status: result.status ?? null,
          durationMs: result.durationMs ?? null,
          parsedStdout: parsed ?? null,
          // batchResults holds the raw stdout when it was not JSON; the caller usually wants it
          // on a failure and it is the only place plain-text output survives.
          raw: parsed ? undefined : String(result.batchResults ?? '').slice(0, 4000),
        };
      } finally {
        // Teardown regardless of outcome — a dry run that leaves a lane behind is not a dry run.
        if (transitionCreated) {
          await exec.execute('DELETE_TRANSITION' as any, { transitionId: tid, model }).catch(() => {});
        }
        for (const p of created) {
          await exec.execute('DELETE_PLACE' as any, { placeId: p, model }).catch(() => {});
        }
      }
    }),
  );
}
