/** application_view: one server read of an application's declared view, and its 404 answer. */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

function config(): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'readonly', session: 'mcp', nodeHost: 'localhost:8080',
    transport: 'stdio', httpPort: 0, llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-test-allowlist.json', persistAllowlist: false,
  };
}

async function connect(get: (path: string) => any) {
  const ctx = new AppContext(config());
  const calls: string[] = [];
  (ctx.master as any).get = async (path: string) => { calls.push(path); return get(path); };
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, calls };
}

const call = async (client: Client, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name: 'application_view', arguments: args })) as any).content[0].text);

describe('application_view', () => {
  it('reads the view with limit and since, also for a readonly observer', async () => {
    const { client, calls } = await connect(() => ({ view: 'open-prompts', count: 1, items: [{ id: 'p1', properties: { promptId: 'q1' } }] }));
    const out = await call(client, { name: 'interview', view: 'open-prompts', limit: 5, since: '2026-10-15T00:00:00Z' });
    expect(out.items[0].properties.promptId).toBe('q1');
    expect(calls).toEqual(['/applications/m1/interview/views/open-prompts?limit=5&since=2026-10-15T00%3A00%3A00Z']);
  });

  it('answers available:false for an unknown view', async () => {
    const { client } = await connect(() => { const e: any = new Error('nf'); e.status = 404; throw e; });
    expect(await call(client, { name: 'interview', view: 'nope' })).toMatchObject({ available: false, view: 'nope' });
  });
});
