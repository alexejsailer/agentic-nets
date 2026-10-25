import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

async function connect(mode: 'rw' | 'readonly' = 'rw', reviewTools = true) {
  const ctx = new AppContext({ gatewayUrl: 'http://localhost:0', models: ['m1', 'm2'], mode,
    session: 'mcp', nodeHost: 'localhost:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false, persistedModels: [],
    allowlistPath: '/tmp/focus-rounds-test.json', persistAllowlist: false, nativeTools: 'curated', reviewTools,
  } as McpConfig);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  (ctx.client as any).masterApi = async (method: string, path: string, body: unknown) => {
    calls.push({ method, path, body }); return { roundId: 'r', state: 'queued' };
  };
  const server = createServer(ctx), [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, calls };
}
const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'focus_round', arguments: args });
describe('guided Focus rounds over MCP', () => {
  it('routes a stable start identity and scope to the selected model', async () => {
    const { client, calls } = await connect();
    await call(client, { action: 'start', roundId: 'r', topic: 'Approval', scope: 'domain:sales', model: 'm2', profileId: 'codex-read-only' });
    expect(calls).toEqual([{ method: 'POST', path: '/explorer/m2/rounds', body: { roundId: 'r', topic: 'Approval', scope: 'domain:sales', profileId: 'codex-read-only' } }]);
    await client.close();
  });
  it('preserves selected answers, text and investigation intent', async () => {
    const { client, calls } = await connect();
    await call(client, { action: 'answer', roundId: 'r', promptId: 'q', selected: ['owner'], text: 'Only once' });
    await call(client, { action: 'answer', roundId: 'r', promptId: 'q2', unknown: true });
    expect(calls[0]).toMatchObject({ path: '/explorer/m1/rounds/r/answer', body: { selected: ['owner'], text: 'Only once' } });
    expect(calls[1].body).toMatchObject({ unknown: true }); await client.close();
  });
  it('refines and retries only the named round and reads its receipts', async () => {
    const { client, calls } = await connect();
    await call(client, { action: 'refine', roundId: 'r' }); await call(client, { action: 'retry', roundId: 'r' });
    await client.callTool({ name: 'focus_rounds', arguments: { roundId: 'r' } });
    expect(calls.map(c => c.path)).toEqual(['/explorer/m1/rounds/r/refine', '/explorer/m1/rounds/r/retry', '/explorer/m1/rounds/r']);
    await client.close();
  });
  it('rejects starts without a topic/scope and models outside the allowlist', async () => {
    const { client, calls } = await connect();
    expect((await call(client, { action: 'start', roundId: 'r' })).isError).toBe(true);
    expect((await call(client, { action: 'retry', roundId: 'r', model: 'other' })).isError).toBe(true);
    expect(calls).toEqual([]); await client.close();
  });
  it('exposes reads on read-only connections and hides all round tools when review tools are off', async () => {
    const ro = await connect('readonly'); const names = (await ro.client.listTools()).tools.map(t => t.name);
    expect(names).toContain('focus_rounds'); expect(names).not.toContain('focus_round'); await ro.client.close();
    const off = await connect('rw', false); const hidden = (await off.client.listTools()).tools.map(t => t.name);
    expect(hidden).not.toContain('focus_rounds'); expect(hidden).not.toContain('focus_round'); await off.client.close();
  });
});
