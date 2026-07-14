/**
 * The knowledge tool — search over the BUNDLED operational docs. Registered
 * unconditionally (rw AND readonly): it performs zero network I/O and zero
 * mutation — it greps an in-process string table shipped inside this binary.
 * Readonly connections are typically observers debugging someone else's net,
 * exactly the population that needs the docs most.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';
import { KNOWLEDGE, searchKnowledge } from '../knowledge/index.js';

export function registerKnowledgeTools(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search the bundled Agentic-Nets docs',
      description:
        'Full-text search over the BUNDLED operational knowledge base (offline — no server call, works in readonly). ' +
        'Returns matching topics with the best excerpt and the agenticnets://docs/{topic} URI to read in full. ' +
        'Use it before guessing at inscription fields, emit rules, ArcQL, template functions, scheduling, executor selection, or debugging steps — ' +
        `topics: ${Object.keys(KNOWLEDGE).join(', ')}. ` +
        'Distinct from the UPPERCASE native SEARCH_KNOWLEDGE tool, which queries the server-side knowledge graph.',
      inputSchema: {
        query: z.string().describe('Search terms, e.g. "emit catch-all token loss" or "queued no output"'),
        topic: z.string().optional().describe('Restrict to one topic key (see agenticnets://docs)'),
        limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)'),
      },
    },
    // wrapTool purely for uniform error shaping; the tool is model-agnostic (no model param).
    wrapTool(scope, config.mode, { name: 'search_knowledge', mutates: false }, async (_model, args) =>
      searchKnowledge(String(args.query ?? ''), { topic: args.topic, limit: args.limit }),
    ),
  );
}
