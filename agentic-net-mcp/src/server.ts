/**
 * Server assembly: curated tools (mode-aware), resources, prompts, instructions.
 * In readonly mode, mutating tools are NOT registered at all (clients never see
 * them) — the scope guard and the gateway's readonly enforcement back that up.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { buildInstructions } from './instructions.js';
import { registerCatalogTools } from './tools/catalog.js';
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

  // Read layers are always available.
  registerObserveTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  if (ctx.config.mode === 'readonly') {
    // memory_recall / memory_graph are read-only but live in the memory module;
    // register the module and rely on wrapTool to reject the mutators is NOT
    // enough here — we want them absent. So: register only the readers.
    registerMemoryReaders(server, ctx);
  } else {
    registerMemoryTools(server, ctx);
    registerNetTools(server, ctx);
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
          const readers = new Set(['memory_recall', 'memory_graph']);
          if (!readers.has(name)) return { name, disabled: true };
          return target.registerTool(name as any, config, handler);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  registerMemoryTools(proxy as unknown as McpServer, ctx);
}
