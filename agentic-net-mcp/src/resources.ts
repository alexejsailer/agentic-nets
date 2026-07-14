/**
 * MCP resources — read surfaces and the knowledge base that teaches clients
 * how to use Agentic-Nets well (distilled from the agenticos-control plugin's
 * skill references and hard-won operating experience).
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { KNOWLEDGE } from './knowledge/index.js';
import { TEMPLATES } from './templates/index.js';
import { nativeCatalog } from './tools/catalog.js';

export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    'models',
    'agenticnets://models',
    { title: 'Allowed models', description: 'The model allowlist, default model, and mode', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            { allowed: ctx.scope.allowed, default: ctx.scope.defaultModel, mode: ctx.config.mode, session: ctx.config.session },
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'templates',
    'agenticnets://templates',
    { title: 'Starter templates', description: 'Deployable templates with their parameters', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            Object.values(TEMPLATES).map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              params: t.params ?? {},
              tags: t.tags ?? [],
            })),
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'tool-catalog',
    'agenticnets://tool-catalog',
    {
      title: 'Native tool catalog',
      description: 'Every platform-native tool exposed by this server (UPPERCASE names — same catalog agent transitions use in-net)',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            nativeCatalog().map((t) => ({
              name: t.name,
              description: t.description,
              params: Object.keys(t.input_schema?.properties ?? {}),
              required: t.input_schema?.required ?? [],
            })),
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'hub',
    'agenticnets://hub',
    { title: 'NetHub — local catalog + remotes', description: 'Published artifacts on this instance and the registered peer remotes', mimeType: 'application/json' },
    async (uri) => {
      const [catalog, remotes] = await Promise.all([
        ctx.master.hubCatalog().catch(() => ({ note: 'hub catalog unavailable' })),
        ctx.master.hubListRemotes().catch(() => ({ remotes: [] })),
      ]);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ catalog, remotes }, null, 1) }] };
    },
  );

  server.registerResource(
    'tool-nets',
    'agenticnets://tool-nets',
    { title: 'Tool-net library', description: 'Reusable tool-nets you can invoke_tool_net', mimeType: 'application/json' },
    async (uri) => {
      const res = await ctx.executorFor(ctx.scope.defaultModel).execute('LIST_TOOL_NETS', {}).catch(() => null);
      const data = res?.success ? res.data : { note: 'no tool-nets found or library unavailable', tools: [] };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 1) }] };
    },
  );

  server.registerResource(
    'docs',
    new ResourceTemplate('agenticnets://docs/{topic}', {
      list: async () => ({
        resources: Object.entries(KNOWLEDGE).map(([topic, d]) => ({
          uri: `agenticnets://docs/${topic}`,
          name: d.title,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: 'Agentic-Nets knowledge base', description: Object.keys(KNOWLEDGE).join(' | ') },
    async (uri, { topic }) => {
      const doc = KNOWLEDGE[String(topic)];
      if (!doc) throw new Error(`unknown doc topic '${topic}' (have: ${Object.keys(KNOWLEDGE).join(', ')})`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.text }] };
    },
  );
}
