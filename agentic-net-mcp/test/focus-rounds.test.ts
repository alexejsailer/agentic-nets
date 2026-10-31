import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

async function connect(mode: 'rw' | 'readonly' = 'rw') {
  const ctx = new AppContext({ gatewayUrl: 'http://localhost:0', models: ['m1', 'm2'], mode,
    session: 'mcp', nodeHost: 'localhost:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false, persistedModels: [],
    allowlistPath: '/tmp/focus-rounds-test.json', persistAllowlist: false, nativeTools: 'curated',
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
    expect(calls).toEqual([{ method: 'POST', path: '/explorer/m2/refinement/rounds', body: { roundId: 'r', topic: 'Approval', scope: 'domain:sales', profileId: 'codex-read-only' } }]);
    await client.close();
  });
  it('starts from a plain-language goal without requiring any net, session or scope', async () => {
    const { client, calls } = await connect();
    const result = await call(client, { action: 'start', roundId: 'r', topic: 'Make morning advice clearer', model: 'm2' });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([{ method: 'POST', path: '/explorer/m2/refinement/rounds', body: { roundId: 'r', topic: 'Make morning advice clearer' } }]);
    await client.close();
  });
  it('preserves selected answers, text and investigation intent', async () => {
    const { client, calls } = await connect();
    await call(client, { action: 'answer', roundId: 'r', promptId: 'q', selected: ['owner'], text: 'Only once' });
    await call(client, { action: 'answer', roundId: 'r', promptId: 'q2', unknown: true });
    expect(calls[0]).toMatchObject({ path: '/explorer/m1/refinement/rounds/r/answer', body: { selected: ['owner'], text: 'Only once' } });
    expect(calls[1].body).toMatchObject({ unknown: true }); await client.close();
  });
  it('lets the headless agent register discovery and apply model edits through MCP with its exact job identity', async () => {
    const { client, calls } = await connect();
    const discovered = { roundId: 'r', requestId: 'r-question-1', scopeNets: ['rules::advice', 'modules::advice'], scopeSummary: 'Morning advice' };
    await client.callTool({ name: 'focus_round_scope', arguments: discovered });
    const operations = [{ id: 'advice-text', kind: 'definition', target: 'rules::advice', definition: { interactions: 'Clarified from the saved answer' } }];
    await client.callTool({ name: 'focus_round_apply', arguments: { roundId: 'r', requestId: 'r-refine-2', operations } });
    expect(calls).toEqual([
      { method: 'POST', path: '/explorer/m1/refinement/rounds/r/scope', body: { requestId: 'r-question-1', scopeNets: discovered.scopeNets, scopeSummary: discovered.scopeSummary } },
      { method: 'POST', path: '/explorer/m1/refinement/rounds/r/apply', body: { requestId: 'r-refine-2', operations } },
    ]);
    await client.close();
  });
  it('refines and retries only the named round and reads its receipts', async () => {
    const { client, calls } = await connect();
    await call(client, { action: 'refine', roundId: 'r' }); await call(client, { action: 'implement', roundId: 'r' }); await call(client, { action: 'retry', roundId: 'r' });
    await client.callTool({ name: 'focus_rounds', arguments: { roundId: 'r' } });
    expect(calls.map(c => c.path)).toEqual(['/explorer/m1/refinement/rounds/r/refine', '/explorer/m1/refinement/rounds/r/implement', '/explorer/m1/refinement/rounds/r/retry', '/explorer/m1/refinement/rounds/r?modelId=m1']);
    await client.close();
  });
  it('rejects starts without a topic and models outside the allowlist', async () => {
    const { client, calls } = await connect();
    expect((await call(client, { action: 'start', roundId: 'r' })).isError).toBe(true);
    expect((await call(client, { action: 'retry', roundId: 'r', model: 'other' })).isError).toBe(true);
    expect(calls).toEqual([]); await client.close();
  });
  it('exposes reads on read-only connections and every round tool on rw ones', async () => {
    const ro = await connect('readonly'); const names = (await ro.client.listTools()).tools.map(t => t.name);
    expect(names).toContain('focus_rounds'); expect(names).not.toContain('focus_round'); await ro.client.close();
    expect(names).not.toContain('focus_round_scope'); expect(names).not.toContain('focus_round_apply');
    const rw = await connect('rw'); const all = (await rw.client.listTools()).tools.map(t => t.name);
    for (const n of ['focus_rounds', 'focus_round', 'focus_round_scope', 'focus_round_apply']) expect(all).toContain(n);
    await rw.client.close();
  });
});
