import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';
import { KNOWLEDGE, searchKnowledge } from '../src/knowledge/index.js';

function makeConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0',
    models: ['m1'],
    mode: 'rw',
    session: 'test',
    nodeHost: 'localhost:8080',
    transport: 'stdio',
    httpPort: 0,
    llmProvider: 'claude-code',
    llmTier: 'medium',
    allowModelCreate: false,
    ...overrides,
  };
}

async function connectedClient(config: McpConfig) {
  const server = createServer(new AppContext(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('searchKnowledge (pure)', () => {
  it('finds a topic by its distinctive vocabulary and returns the resource URI', () => {
    const { results } = searchKnowledge('double equals double quotes');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].topic).toBe('arcql');
    expect(results[0].uri).toBe('agenticnets://docs/arcql');
    expect(results[0].excerpt.length).toBeGreaterThan(20);
  });

  it('scores section headings and caps results per topic at 2', () => {
    const { results } = searchKnowledge('crystallizing', { limit: 10 });
    const fromRecipes = results.filter((r) => r.topic === 'recipes');
    expect(fromRecipes.length).toBeGreaterThan(0);
    expect(fromRecipes.length).toBeLessThanOrEqual(2);
  });

  it('topic filter restricts the corpus', () => {
    const { results } = searchKnowledge('token', { topic: 'security' });
    for (const r of results) expect(r.topic).toBe('security');
  });

  it('zero hits return a hint naming the topics', () => {
    const { results, hint } = searchKnowledge('xylophone zeppelin quux');
    expect(results).toEqual([]);
    expect(hint).toContain('concepts');
  });

  it('every result URI resolves to a real topic', () => {
    const { results } = searchKnowledge('transition', { limit: 10 });
    for (const r of results) {
      expect(KNOWLEDGE[r.topic], r.uri).toBeDefined();
    }
  });
});

describe('search_knowledge over the protocol', () => {
  it('is advertised and callable in rw mode', async () => {
    const client = await connectedClient(makeConfig());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('search_knowledge');

    const res: any = await client.callTool({ name: 'search_knowledge', arguments: { query: 'arcql double equals' } });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0].uri).toMatch(/^agenticnets:\/\/docs\//);
  });

  it('is advertised in READONLY mode too (offline, zero mutation)', async () => {
    const client = await connectedClient(makeConfig({ mode: 'readonly' }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('search_knowledge');
  });

  it('returned URIs are readable as resources', async () => {
    const client = await connectedClient(makeConfig());
    const res: any = await client.callTool({ name: 'search_knowledge', arguments: { query: 'kill switch pause' } });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.results.length).toBeGreaterThan(0);
    const read: any = await client.readResource({ uri: payload.results[0].uri });
    expect(read.contents[0].text.length).toBeGreaterThan(100);
  });
});
