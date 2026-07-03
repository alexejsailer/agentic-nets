/**
 * Registration-shape tests: drive the REAL server through an in-memory MCP
 * transport pair and assert the advertised surface (the same truths verified
 * against the live binary during development).
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

function makeConfig(over: Partial<McpConfig> = {}): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0',
    models: ['m1'],
    mode: 'rw',
    session: 'mcp',
    nodeHost: 'localhost:8080',
    transport: 'stdio',
    httpPort: 0,
    ...over,
  };
}

async function connectedClient(config: McpConfig) {
  const server = createServer(new AppContext(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const CURATED = [
  'net_overview',
  'query_tokens',
  'event_trail',
  'memory_write',
  'memory_recall',
  'memory_link',
  'memory_graph',
  'deploy_template',
  'create_net',
  'add_place',
  'add_transition',
  'set_schedule',
  'fire_once',
  'start_transition',
  'stop_transition',
  'create_persona',
  'scaffold_tool_net',
  'invoke_tool_net',
].sort();

describe('advertised tool surface', () => {
  it('rw single-model: exactly the 18 curated tools, NO model param anywhere', async () => {
    const client = await connectedClient(makeConfig());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(CURATED);
    for (const t of tools) {
      expect(Object.keys((t.inputSchema as any)?.properties ?? {}), t.name).not.toContain('model');
    }
  });

  it('rw multi-model: every tool gains an optional model param', async () => {
    const client = await connectedClient(makeConfig({ models: ['m1', 'm2'] }));
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(Object.keys((t.inputSchema as any)?.properties ?? {}), t.name).toContain('model');
    }
  });

  it('readonly: only the five read tools are registered at all', async () => {
    const client = await connectedClient(makeConfig({ mode: 'readonly' }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['event_trail', 'memory_graph', 'memory_recall', 'net_overview', 'query_tokens'].sort(),
    );
  });

  it('server delivers teaching instructions at initialize', async () => {
    const client = await connectedClient(makeConfig());
    expect(client.getInstructions()).toMatch(/working memory that runs/i);
    expect(client.getInstructions()).toMatch(/ArcQL/);
  });

  it('resources include the knowledge base and catalogs', async () => {
    const client = await connectedClient(makeConfig());
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('agenticnets://models');
    expect(uris).toContain('agenticnets://templates');
    const doc = await client.readResource({ uri: 'agenticnets://docs/arcql' });
    expect((doc.contents[0] as any).text).toMatch(/DOUBLE equals/);
  });

  it('prompts are registered', async () => {
    const client = await connectedClient(makeConfig());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(
      ['capture-session', 'debug-net', 'setup-working-memory', 'work-dev-team-backlog'].sort(),
    );
  });

  it('scope guard rejects an out-of-allowlist model through the live protocol (multi-model)', async () => {
    const client = await connectedClient(makeConfig({ models: ['m1', 'm2'] }));
    const res: any = await client.callTool({ name: 'memory_recall', arguments: { query: 'x', model: 'evil' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe('MODEL_NOT_ALLOWED');
  });

  it('single-model: a smuggled model arg is neutralized before the handler (SDK strips unknown args)', async () => {
    const client = await connectedClient(makeConfig());
    const res: any = await client.callTool({ name: 'memory_recall', arguments: { query: 'x', model: 'evil' } });
    // Never MODEL_NOT_ALLOWED-able: the arg is stripped, the call runs against the
    // default model (and here fails only because the test gateway doesn't exist).
    const body = JSON.parse(res.content[0].text);
    expect(body.code).not.toBe('MODEL_NOT_ALLOWED');
  });
});
