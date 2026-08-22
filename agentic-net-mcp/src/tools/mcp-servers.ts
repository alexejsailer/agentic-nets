/**
 * Agent-side MCP: the tools that make "an agent transition can call external MCP servers"
 * discoverable and wireable THROUGH the protocol, instead of something you have to already
 * know about from the docs.
 *
 * Two tools, one read and one write:
 *  - `mcp_servers`  — what can be handed to an agent (including THIS server), what already has
 *                     been, and — with a transitionId — the catalog master itself discovers.
 *  - `attach_mcp_server` — hand one over: edit `action.mcp`, widen the role with the `m` flag,
 *                     and store the credential in the vault.
 *
 * The self case is the reason `attach_mcp_server` exists rather than a documented recipe. This
 * process already holds its own HTTP bearer token, so it can put that token straight into the
 * transition's vault entry. The alternative — telling the client the token so it can call
 * set_transition_credentials — would write a live secret into a model's conversation history,
 * which is exactly what the credentialKey design exists to prevent.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { assignInscription, hasMcpFlag, persistInscriptionLeaf, sanitizeMcp, withMcpFlag, withoutMcpFlag } from '../inscriptions.js';

/** Default server name and credential key used when handing THIS server to an agent. */
export const SELF_SERVER_NAME = 'agenticnets';
export const SELF_CREDENTIAL_KEY = 'AGENTICNETS_MCP_TOKEN';

/**
 * Where master can reach this process's HTTP transport. The bind host is NOT the answer:
 * 0.0.0.0 is not routable, and in compose this container's loopback is not master's. Operators
 * pin it with AGENTICOS_MCP_SELF_URL; the default is right for the Desktop bundle, where master
 * and this process are neighbours on one host.
 */
export function selfUrlFor(config: AppContext['config']): string {
  return config.selfUrl ?? `http://127.0.0.1:${config.httpPort}/mcp`;
}

/**
 * Describe whether THIS Agentic-Nets MCP server can be given to an agent transition, and how.
 * Honest about the stdio case: a stdio process has no endpoint for master to call, so there is
 * nothing to hand over, and saying so beats emitting a URL that will never answer.
 */
export function describeSelf(ctx: AppContext): Record<string, any> {
  const { config } = ctx;
  if (config.transport !== 'http' || !config.httpToken) {
    return {
      attachable: false,
      transport: config.transport,
      reason:
        'This Agentic-Nets MCP server speaks stdio, so it has no HTTP endpoint for master to call — '
        + 'an agent transition can only reach MCP servers over Streamable HTTP. To give agents an '
        + 'Agentic-Nets server, run one with AGENTICOS_MCP_TRANSPORT=http (the Desktop bundle already '
        + 'runs one on :8091), then attach it with attach_mcp_server {server:{name,url,auth:{credentialKey}}} '
        + 'and store its AGENTICOS_MCP_HTTP_TOKEN with set_transition_credentials.',
    };
  }
  const url = selfUrlFor(config);
  return {
    attachable: true,
    transport: 'http',
    url,
    urlNote: config.selfUrl
      ? 'pinned by AGENTICOS_MCP_SELF_URL'
      : `derived from AGENTICOS_MCP_HTTP_PORT (${config.httpPort}); correct when master runs on this host. `
        + 'If master is in another container or on another machine, set AGENTICOS_MCP_SELF_URL to a URL it can reach.',
    // What an agent reaching this endpoint would actually be able to touch. This is NOT the
    // calling session's scope: a net created through this server lands in the session and model
    // allowlist configured HERE, which is the single most surprising thing about the self case.
    reach: {
      models: config.models,
      session: config.session,
      mode: config.mode,
      note:
        'An agent calling this server acts with THIS server\'s scope, not the calling net\'s: writes land in '
        + `session '${config.session}' and are limited to models [${config.models.join(', ')}].`,
    },
    declaration: {
      name: SELF_SERVER_NAME,
      url,
      auth: { type: 'bearer', credentialKey: SELF_CREDENTIAL_KEY },
    },
    role: withMcpFlag('r'),
    howTo:
      `attach_mcp_server {transitionId:"t-your-agent", self:true} does all of it: adds the declaration, `
      + `widens the role with the m flag, and stores this server's own bearer token under `
      + `${SELF_CREDENTIAL_KEY} in the vault — the token never passes through your context.`,
    recursionNote:
      'An agent that can reach this server can build and change nets. Narrow it with allowTools '
      + '(e.g. ["query_tokens","memory_recall"]) unless the lane is genuinely meant to author structure.',
  };
}

/**
 * Pull `action.mcp` + role off every agent inscription in the model, in one call.
 *
 * Returns the number of inscriptions actually examined alongside the hits: an empty `declared`
 * list means "none of them declares a server" ONLY if something was read. A model that has not
 * been loaded yet answers with zero inscriptions, and reporting that as "nothing declared" would
 * be a confident wrong answer (observed live on a CATALOGED model's first call).
 */
async function scanDeclared(ctx: AppContext, model: string): Promise<{ rows: any[]; scanned: number; note?: string }> {
  const res: any = await ctx
    .executorFor(model)
    .execute('LIST_ALL_INSCRIPTIONS', { includeContent: true })
    .catch(() => null);
  if (!res?.success) {
    return {
      rows: [],
      scanned: 0,
      note: 'inscription content did not load (readonly mode rejects the POST) — cannot list declared MCP servers here.',
    };
  }
  const rows: any[] = [];
  const all: any[] = res.data?.transitions ?? [];
  for (const t of all) {
    const ins = t.inscription ?? {};
    const servers = ins?.action?.mcp;
    if (!Array.isArray(servers) || !servers.length) continue;
    const role = ins.action?.role ?? null;
    rows.push({
      transitionId: String(t.transitionId),
      role,
      // A declaration without the flag is the silent-failure shape: discovery runs, the prompt
      // lists the servers, and MCP_CALL is never in the agent's tool set.
      mcpFlag: hasMcpFlag(role),
      servers: servers.map((s: any) => ({
        name: s?.name,
        url: s?.url,
        credentialKey: s?.auth?.credentialKey ?? null,
        allowTools: s?.allowTools ?? [],
      })),
    });
  }
  return {
    rows,
    scanned: all.length,
    ...(all.length === 0
      ? { note: `no inscriptions were readable in '${model}' — the model may not be loaded yet, so an empty list here is not proof that nothing declares an MCP server. Re-run after list_transitions shows the model's lanes.` }
      : {}),
  };
}

export function registerMcpServerTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  // Single-model connections expose NO model param at all — the scope is implicit and an
  // optional-but-meaningless field is one more thing for a client LLM to get wrong.
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'mcp_servers',
    {
      title: 'External MCP servers an agent transition can call',
      description:
        'Agent transitions can call EXTERNAL MCP servers themselves, declared in the inscription as action.mcp and gated by the 11th role flag m. This tool answers the three questions that come before wiring one: (1) `self` — whether THIS Agentic-Nets server can be handed to an agent, at which URL, with what scope, plus a ready-to-use declaration; (2) `declared` — which agent lanes in this model already carry MCP servers, and whether their role actually grants MCP_CALL; (3) with transitionId, `catalog` — the servers, credential state and TOOL LIST master itself discovers for that lane, using the real vault credentials, WITHOUT firing the agent (so it costs no LLM tokens). Use it before attach_mcp_server, and again after, to prove the lane works. GET-based and readonly-safe.',
      inputSchema: {
        transitionId: z
          .string()
          .optional()
          .describe('Also probe this agent lane: ask master to resolve its action.mcp servers and report the tools it discovers'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'mcp_servers', mutates: false }, async (model, args) => {
      const declared = await scanDeclared(ctx, model);
      const out: Record<string, any> = {
        model,
        self: describeSelf(ctx),
        declared: declared.rows,
        // State what was examined: "0 of 43 lanes declare a server" and "nothing was readable"
        // are different answers and only one of them means the model has no MCP lanes.
        scannedInscriptions: declared.scanned,
        ...(declared.note ? { declaredNote: declared.note } : {}),
      };
      if (args.transitionId) {
        out.catalog = await ctx.client
          .masterApi('GET', '/agent/tools/mcp/catalog', undefined, {
            modelId: model,
            transitionId: String(args.transitionId),
          })
          .catch((err: any) => ({
            error: String(err?.message ?? err),
            note:
              'master could not report the MCP catalog for this transition — on an older master the '
              + 'probe endpoint does not exist yet, in which case the only check is to fire the lane.',
          }));
      }
      return out;
    }),
  );

  if (config.mode === 'readonly') return;

  server.registerTool(
    'attach_mcp_server',
    {
      title: 'Give an agent transition an external MCP server',
      description:
        "Wire an external MCP server into an EXISTING agent transition: adds it to action.mcp, widens action.role with the m flag (without it the agent is never offered MCP_CALL), stores the credential in the vault, and re-assigns the inscription. `self:true` attaches THIS Agentic-Nets server — including its own bearer token, which goes straight into the vault so the secret never passes through your context. Use `server` for any other MCP endpoint (Streamable HTTP only) and pass its secret as `credential`. `remove` detaches by name. The lane is left STOPPED after the edit (the changed-inscription rule); start_transition when you have checked it with mcp_servers {transitionId}.",
      inputSchema: {
        transitionId: z.string().describe('An existing kind:"agent" transition'),
        self: z
          .boolean()
          .optional()
          .describe('Attach THIS Agentic-Nets MCP server (url + bearer token supplied automatically). Requires this server to run on the http transport'),
        server: z
          .object({
            name: z.string().describe('Server name the agent uses in MCP_CALL'),
            url: z.string().describe('Streamable HTTP endpoint, e.g. https://tools.example.com/mcp'),
            auth: z
              .object({
                type: z.enum(['bearer', 'header']).optional(),
                credentialKey: z.string().describe('Vault key holding the secret — never an inline secret'),
                header: z.string().optional(),
                scheme: z.string().optional(),
              })
              .optional(),
            allowTools: z.array(z.string()).optional(),
            timeoutMs: z.number().positive().optional(),
          })
          .optional()
          .describe('Attach an arbitrary MCP server (alternative to self:true)'),
        credential: z
          .string()
          .optional()
          .describe("The secret for this server's auth.credentialKey. Stored in the vault and never echoed back. Omit when the key is already stored, or when using self:true"),
        allowTools: z
          .array(z.string())
          .optional()
          .describe('Restrict which of the server\'s tools this agent may call. Strongly recommended for self:true — an unrestricted Agentic-Nets server lets the agent author nets'),
        remove: z.string().optional().describe('Detach the server with this name instead of attaching one'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'attach_mcp_server', mutates: true }, async (model, args) => {
      const transitionId = String(args.transitionId);
      const chosen = [args.self ? 'self' : null, args.server ? 'server' : null, args.remove ? 'remove' : null].filter(Boolean);
      if (chosen.length !== 1) {
        throw new Error('pass exactly one of self:true, server:{...} or remove:"<name>"');
      }

      const current: any = await ctx.executorFor(model).execute('GET_TRANSITION', { transitionId });
      const inscription = current?.data?.inscription ?? current?.data;
      if (!inscription || typeof inscription !== 'object') {
        throw new Error(`transition '${transitionId}' has no inscription in model '${model}' (list_transitions shows what exists)`);
      }
      if (inscription.kind !== 'agent') {
        throw new Error(
          `action.mcp only applies to kind:"agent"; '${transitionId}' is kind:"${inscription.kind}". `
            + 'Only an agent runs a tool-using loop, so only an agent can call MCP_CALL.',
        );
      }
      const action = { ...(inscription.action ?? {}) };
      const existing: any[] = Array.isArray(action.mcp) ? [...action.mcp] : [];

      let credentialKey: string | undefined;
      let credentialValue: string | undefined;
      let attached: any;

      if (args.remove) {
        const before = existing.length;
        const kept = existing.filter((s) => s?.name !== args.remove);
        if (kept.length === before) {
          throw new Error(
            `'${transitionId}' declares no MCP server named '${args.remove}' `
              + `(declared: ${existing.map((s) => s?.name).join(', ') || 'none'})`,
          );
        }
        if (kept.length) {
          action.mcp = kept;
        } else {
          // Detaching the LAST server makes the m flag inert (nothing is declared for it to
          // reach), so drop it too — that keeps attach/remove a true inverse and never leaves a
          // lane advertising external reach it does not have.
          delete action.mcp;
          if (hasMcpFlag(action.role)) action.role = withoutMcpFlag(action.role);
        }
      } else {
        const declaration = args.self
          ? (() => {
              const self = describeSelf(ctx);
              if (!self.attachable) throw new Error(self.reason);
              credentialKey = SELF_CREDENTIAL_KEY;
              credentialValue = config.httpToken;
              return { ...self.declaration };
            })()
          : { ...args.server };
        if (args.allowTools?.length) declaration.allowTools = args.allowTools;
        if (!args.self && args.credential) {
          if (!declaration.auth?.credentialKey) {
            throw new Error('credential was provided but server.auth.credentialKey is missing — the vault needs a key to store it under');
          }
          credentialKey = declaration.auth.credentialKey;
          credentialValue = String(args.credential);
        }
        // Reuse the authoring-time guard: it rejects non-http urls and inline secrets before
        // anything is written, which is the difference between a clear error here and a lane
        // that installs, 401s, and shows a redacted auth block when you go looking.
        const [validated] = sanitizeMcp([declaration])!;
        attached = validated;
        const idx = existing.findIndex((s) => s?.name === validated.name);
        if (idx >= 0) existing[idx] = validated;
        else existing.push(validated);
        action.mcp = existing;
        action.role = withMcpFlag(action.role);
      }

      // Stop before swapping: the executor caches inscriptions, and a lane that keeps running
      // through an inscription change fires the old shape for an unbounded window.
      await ctx.master.stopTransition(transitionId, model).catch(() => undefined);

      // Master reads the role from action.role only, but the root-level copy is what a human (and
      // the GUI) reads. Leaving it behind reads as "this agent has no MCP reach" on the surface
      // most people look at first, so keep the two in step whenever the flag is granted.
      const next = { ...inscription, action };
      if (inscription.role !== undefined && action.role !== undefined && inscription.role !== action.role) {
        next.role = action.role;
      }
      await assignInscription(ctx, model, next, 'agentic-net-master');
      const netId = next?.metadata?.netId;
      if (netId) {
        await persistInscriptionLeaf(ctx, model, String(netId), transitionId, next).catch(() => false);
      }
      if (credentialKey && credentialValue) {
        await ctx.client.masterApi('POST', `/transitions/${transitionId}/credentials`, { [credentialKey]: credentialValue }, { modelId: model });
      }

      return {
        transition: transitionId,
        ...(args.remove
          ? { detached: args.remove, role: action.role }
          : {
              attached: { name: attached.name, url: attached.url, allowTools: attached.allowTools ?? [] },
              role: action.role,
              credentialKey: credentialKey ?? attached.auth?.credentialKey ?? null,
              credentialStored: Boolean(credentialKey && credentialValue),
            }),
        declaredServers: Array.isArray(action.mcp) ? action.mcp.map((s: any) => s.name) : [],
        started: false,
        next: [
          `mcp_servers {transitionId:"${transitionId}"} — confirm master reaches the server and see the tool list it will offer`,
          `start_transition {transitionId:"${transitionId}"} — the lane was stopped for the inscription change`,
        ],
        ...(credentialKey && !credentialValue
          ? {
              warning:
                `no credential value was stored for '${credentialKey}'. If the vault does not already hold it, `
                + 'the server fails closed at fire time with "credential not provided" and the agent sees it as UNAVAILABLE. '
                + `Store it with set_transition_credentials {transitionId:"${transitionId}", credentials:{"${credentialKey}":"..."}}.`,
            }
          : {}),
      };
    }),
  );
}
