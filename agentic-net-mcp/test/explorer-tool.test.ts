/**
 * explore_model: the one MCP view of the net hierarchy. Pins the summary shape, the query filter,
 * the full passthrough, and the graceful answer against a master that predates /api/explorer.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';
import { hierarchyLines, summarize } from '../src/tools/explorer.js';

function config(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp',
    nodeHost: 'localhost:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-explorer-test.json',
    persistAllowlist: false, nativeTools: 'curated',
    ...overrides,
  } as McpConfig;
}

const CATALOGUE = {
  modelId: 'm1',
  modelVersion: 42,
  levels: [{ id: 'product', name: 'Product', order: 0 }, { id: 'service', name: 'Service', order: 1 }],
  sessions: [{ sessionId: 'product', netCount: 1 }, { sessionId: 'identity', netCount: 2 }],
  nets: [
    { key: 'product::overview', title: 'Product overview', description: 'The product at a glance', depth: 0, placeCount: 3, transitionCount: 2, inscribedTransitionCount: 1, definitionStatus: 'realized' },
    { key: 'identity::account-access', title: 'Account access', description: 'Login and sessions', depth: 1, placeCount: 5, transitionCount: 4, inscribedTransitionCount: 4, definitionStatus: 'realized' },
    { key: 'identity::risk-analysis', title: 'Authentication analysis', description: 'Explain risks', depth: 1, placeCount: 0, transitionCount: 0, inscribedTransitionCount: 0, definitionStatus: 'draft' },
  ],
  hierarchy: [
    { parent: { sessionId: 'product', netId: 'overview' }, elementId: 't-auth', elementType: 'transition', childKey: 'identity::account-access', inline: false, verified: 'ok' },
    { parent: { sessionId: 'product', netId: 'overview' }, elementId: 't-risk', elementType: 'transition', childKey: 'identity::risk-analysis', inline: false, verified: 'targetMissing' },
  ],
  places: [
    { ref: { placeId: 'p-auth-findings' }, label: 'Auth findings', shared: true, drawnIn: [{}, {}], readers: [{}], writers: [{}, {}] },
    { ref: { placeId: 'p-private' }, label: 'Private', shared: false, drawnIn: [{}], readers: [], writers: [{}] },
  ],
  definitions: [{ ref: { sessionId: 'identity', netId: 'risk-analysis' }, status: 'draft', revision: 1 }],
  stats: { sessionCount: 2, netCount: 3, maxDepth: 1, sharedPlaceCount: 1 },
  warnings: [{ code: 'subnet-target-missing', message: 'x', subject: 't-risk' }],
};

async function connect(master: (path: string) => any) {
  const ctx = new AppContext(config());
  const calls: string[] = [];
  (ctx.client as any).masterApi = async (_m: string, path: string) => {
    calls.push(path);
    return master(path);
  };
  const server = createServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, calls };
}

async function call(client: Client, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name: 'explore_model', arguments: args });
  return JSON.parse(result.content[0].text);
}

describe('explore_model', () => {
  it('summary: counts, levels, indented hierarchy, compact nets and the most shared places', async () => {
    const { client, calls } = await connect(() => CATALOGUE);
    const out = await call(client);
    expect(calls).toEqual(['/explorer/m1/catalogue?modelId=m1']);
    expect(out.modelId).toBe('m1');
    expect(out.stats.netCount).toBe(3);
    expect(out.levels.map((l: any) => l.id)).toEqual(['product', 'service']);
    expect(out.hierarchy).toEqual([
      'product::overview (depth 0)',
      '  identity::account-access (depth 1, via t-auth, ok)',
      '  identity::risk-analysis (depth 1, via t-risk, targetMissing, definition draft)',
    ]);
    expect(out.nets.map((n: any) => n.key)).toEqual(['product::overview', 'identity::account-access', 'identity::risk-analysis']);
    expect(out.nets[0]).not.toHaveProperty('description');
    expect(out.topSharedPlaces).toEqual([
      { placeId: 'p-auth-findings', label: 'Auth findings', drawnIn: 2, readers: 1, writers: 2 },
    ]);
    expect(out.warnings).toHaveLength(1);
    expect(out).not.toHaveProperty('places');
  });

  it('query filters nets by key, title or description and reports matched/total', async () => {
    const { client } = await connect(() => CATALOGUE);
    const byTitle = await call(client, { query: 'account' });
    expect(byTitle.nets.map((n: any) => n.key)).toEqual(['identity::account-access']);
    expect(byTitle.matched).toBe(1);
    expect(byTitle.total).toBe(3);
    const byDescription = await call(client, { query: 'RISKS' });
    expect(byDescription.nets.map((n: any) => n.key)).toEqual(['identity::risk-analysis']);
    const full = await call(client, { detail: 'full', query: 'identity::' });
    expect(full.nets).toHaveLength(2);
    expect(full.places).toHaveLength(2);
  });

  it('full returns the whole document untouched', async () => {
    const { client } = await connect(() => CATALOGUE);
    const out = await call(client, { detail: 'full' });
    expect(out).toEqual(CATALOGUE);
  });

  it('a master without /api/explorer answers available:false instead of throwing', async () => {
    const { client } = await connect(() => {
      const err: any = new Error('Gateway 404 (GET /api/explorer/m1/catalogue): not found');
      err.status = 404;
      throw err;
    });
    const out = await call(client);
    expect(out.available).toBe(false);
    expect(out.hint).toMatch(/master without \/api\/explorer/);
  });

  it('is registered in readonly mode too', async () => {
    const ctx = new AppContext(config({ mode: 'readonly' }));
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'explore_model');
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/session::netId/);
    expect(tool!.description).toMatch(/never fires/);
  });
});

describe('hierarchyLines', () => {
  it('lists a net whose parent is unknown to the catalogue at the root instead of dropping it', () => {
    const lines = hierarchyLines({
      nets: [{ key: 'a::x', depth: 1 }],
      hierarchy: [{ parent: { sessionId: 'gone', netId: 'y' }, elementId: 't', childKey: 'a::x', verified: 'targetMissing' }],
    });
    expect(lines).toEqual(['a::x (depth 1, via t, targetMissing)']);
  });

  it('summarize tolerates an empty document', () => {
    const out = summarize({});
    expect(out.hierarchy).toEqual([]);
    expect(out.nets).toEqual([]);
    expect(out.topSharedPlaces).toEqual([]);
  });
});
