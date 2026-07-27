/**
 * Server assembly: curated tools (mode-aware), resources, prompts, instructions.
 * In readonly mode, mutating tools are NOT registered at all (clients never see
 * them) — the scope guard and the gateway's readonly enforcement back that up.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { buildInstructions } from './instructions.js';
import { setScopeEchoSession, toolRegistry } from './scope.js';
import { registerAgentTools } from './tools/agents.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerExternalReaders, registerExternalTools } from './tools/external.js';
import { registerHostedTools } from './tools/hosted.js';
import { registerHubTools } from './tools/hub.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerNetTools } from './tools/nets.js';
import { registerObserveTools } from './tools/observe.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export const SERVER_NAME = 'agenticnets';
export const SERVER_VERSION = '0.1.0';

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(ctx.config) },
  );
  setScopeEchoSession(ctx.config.session);

  // Stamp MCP-standard annotations (readOnlyHint/destructiveHint) onto every
  // registration from the wrapTool spec — clients see mutation risk in
  // tools/list, before any call is made. wrapTool() records the spec during
  // argument evaluation, i.e. before this wrapper body runs for that tool.
  const registerWithAnnotations = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, handler: any) => {
    const spec = toolRegistry.get(String(name));
    if (config && config.annotations === undefined && spec) {
      config = {
        ...config,
        annotations: {
          readOnlyHint: !spec.mutates,
          destructiveHint: spec.mutates && spec.destructive === true,
          // A read is idempotent by definition; a write only when it declares itself so. Lets a
          // client decide whether retrying after a timeout is safe instead of guessing from prose.
          idempotentHint: !spec.mutates || spec.idempotent === true,
          // Whether the tool can reach outside this deployment. Everything here talks to the
          // model unless it says otherwise, so the safe default is false.
          openWorldHint: spec.openWorld === true,
        },
      };
    }
    return registerWithAnnotations(name as any, config, handler);
  };

  // Read layers are always available (search_knowledge greps the bundled docs —
  // zero network, zero mutation — so it serves readonly observers too).
  registerObserveTools(server, ctx);
  registerKnowledgeTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  if (ctx.config.mode === 'readonly') {
    // memory_recall / memory_graph are read-only but live in the memory module;
    // register the module and rely on wrapTool to reject the mutators is NOT
    // enough here — we want them absent. So: register only the readers.
    registerMemoryReaders(server, ctx);
    // External-fire discovery is GET-based — readonly observers can see the lane.
    registerExternalReaders(server, ctx);
  } else {
    registerMemoryTools(server, ctx);
    registerNetTools(server, ctx);
    // Invoke the platform agents (builder/operator/persona/...) — same agent loop as the GUI.
    registerAgentTools(server, ctx);
    // NetHub — publish/discover/install artifacts across instances.
    registerHubTools(server, ctx);
    // Client-hosted llm/agent execution — this process as the transition runner.
    registerHostedTools(server, ctx);
    // External fires — the host model itself answers llm/agent transitions via master.
    registerExternalTools(server, ctx);
    // Full native parity: every ToolExecutor tool, canonical UPPERCASE names.
    registerCatalogTools(server, ctx);
  }

  return server;
}

/** Readonly registration: only the two non-mutating memory tools. */
function registerMemoryReaders(server: McpServer, ctx: AppContext): void {
  // Reuse the full module but strip mutators by registering into a throwaway
  // server is overkill — the memory module's two readers are self-contained
  // enough to re-register directly with the same handlers.
  // Implementation: call the full registrar against a proxy that drops mutators.
  const proxy = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: any, handler: any) => {
          const readers = new Set(['memory_recall', 'memory_graph', 'domain_memory_recall']);
          if (!readers.has(name)) return { name, disabled: true };
          return target.registerTool(name as any, config, handler);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  registerMemoryTools(proxy as unknown as McpServer, ctx);
}
