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
    llmProvider: 'claude-code',
    llmTier: 'medium',
    allowModelCreate: false,
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
  // observability (also available in readonly, except the POST-based diagnostics)
  'net_overview',
  'query_tokens',
  'event_trail',
  'net_stats',
  'list_transitions',
  'list_models',
  'list_executors',
  'llm_health',
  'scheduler_status',
  'search_knowledge',
  'diagnose_transition',
  'dry_run_transition',
  'verify_inscription',
  // memory
  'memory_write',
  'memory_recall',
  'memory_link',
  'memory_graph',
  'domain_memory_write',
  'domain_memory_recall',
  // net building
  'deploy_template',
  'create_net',
  'add_place',
  'add_transition',
  'set_schedule',
  'set_transition_credentials',
  'fire_once',
  'start_transition',
  'stop_transition',
  'pause_model',
  'resume_model',
  'host_transition',
  'unhost_transition',
  'create_persona',
  'spawn_persona',
  'scaffold_tool_net',
  'invoke_tool_net',
  'invoke_agent',
  'crystallize_session',
  // NetHub
  'hub_publish',
  'hub_search',
  'hub_show',
  'hub_install',
  'hub_add_remote',
].sort();

describe('advertised tool surface', () => {
  it('rw single-model: curated tools + FULL native catalog, NO model param anywhere', async () => {
    const client = await connectedClient(makeConfig());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // Curated (lowercase) layer: all present.
    for (const c of CURATED) expect(names, `curated ${c}`).toContain(c);
    // Native (UPPERCASE) layer: full platform parity — spot-check breadth across groups
    // and assert the agent-loop-only primitives are excluded.
    for (const n of ['NET_DOCTOR', 'DELETE_NET', 'DELETE_TRANSITION', 'SET_INSCRIPTION', 'QUERY_TOKENS', 'PACKAGE_SEARCH', 'HUB_PUBLISH', 'HUB_INSTALL', 'HUB_REMOTE_ADD', 'DOCKER_LIST', 'HTTP_CALL', 'EXPORT_PNML']) {
      expect(names, `native ${n}`).toContain(n);
    }
    for (const excluded of ['THINK', 'DONE', 'FAIL']) expect(names).not.toContain(excluded);
    const native = names.filter((n) => n === n.toUpperCase() && /_|^[A-Z]+$/.test(n));
    expect(native.length).toBeGreaterThanOrEqual(60); // 65 catalog − 3 loop-only ≥ 62
    expect(names.length).toBe(CURATED.length + native.length); // no strays
    for (const t of tools) {
      expect(Object.keys((t.inputSchema as any)?.properties ?? {}), t.name).not.toContain('model');
    }
  });

  it('native catalog schemas keep param metadata (descriptions + required)', async () => {
    const client = await connectedClient(makeConfig());
    const { tools } = await client.listTools();
    const qt = tools.find((t) => t.name === 'QUERY_TOKENS');
    const props = (qt!.inputSchema as any).properties;
    expect(Object.keys(props).length).toBeGreaterThan(0);
    expect((qt!.inputSchema as any).required?.length ?? 0).toBeGreaterThan(0);
  });

  it('rw multi-model: every model-scoped tool gains an optional model param', async () => {
    const client = await connectedClient(makeConfig({ models: ['m1', 'm2'] }));
    const { tools } = await client.listTools();
    // Model-AGNOSTIC tools have no model param by design: list_models surveys
    // the whole stack; create_model takes the NEW id; hub_search/hub_add_remote
    // are cross-instance, not model-scoped.
    const modelAgnostic = new Set(['list_models', 'create_model', 'hub_search', 'hub_show', 'hub_add_remote', 'llm_health', 'search_knowledge']);
    for (const t of tools) {
      if (modelAgnostic.has(t.name)) continue;
      expect(Object.keys((t.inputSchema as any)?.properties ?? {}), t.name).toContain('model');
    }
  });

  it('allowModelCreate: create_model registered, and even single-model configs expose the model param', async () => {
    const client = await connectedClient(makeConfig({ allowModelCreate: true }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('create_model');
    // A freshly created model must be reachable => model param exists everywhere.
    const write = tools.find((t) => t.name === 'memory_write');
    expect(Object.keys((write!.inputSchema as any).properties)).toContain('model');
    // And with creation disabled it is absent entirely (frozen allowlist).
    const frozen = await connectedClient(makeConfig());
    const { tools: frozenTools } = await frozen.listTools();
    expect(frozenTools.map((t) => t.name)).not.toContain('create_model');
  });

  it('scaffold_tool_net exposes transitionKind (pre-wired crystallization)', async () => {
    const client = await connectedClient(makeConfig());
    const { tools } = await client.listTools();
    const scaffold = tools.find((t) => t.name === 'scaffold_tool_net');
    const props = (scaffold!.inputSchema as any).properties;
    expect(Object.keys(props)).toContain('transitionKind');
    expect(props.transitionKind.enum ?? props.transitionKind.anyOf).toBeTruthy();
    // invoke_tool_net is typed (netId, not opaque params)
    const invoke = tools.find((t) => t.name === 'invoke_tool_net');
    expect(Object.keys((invoke!.inputSchema as any).properties)).toContain('netId');
    expect(Object.keys((invoke!.inputSchema as any).properties)).not.toContain('params');
  });

  it('readonly: only the read tools are registered (GET-based; POST diagnostics excluded)', async () => {
    const client = await connectedClient(makeConfig({ mode: 'readonly' }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['domain_memory_recall', 'event_trail', 'list_executors', 'list_models', 'list_transitions', 'llm_health', 'memory_graph', 'memory_recall', 'net_overview', 'net_stats', 'query_tokens', 'scheduler_status', 'search_knowledge'].sort(),
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
      ['capture-session', 'debug-net', 'monitor-personas', 'setup-working-memory', 'spawn-worker', 'work-dev-team-backlog'].sort(),
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
