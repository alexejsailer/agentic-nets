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
    // Durable allowlist: tests run fully isolated from any real ~/.agenticnets state.
    persistedModels: [],
    allowlistPath: '/tmp/agenticnets-test-allowlist.json',
    persistAllowlist: false,
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
  'readiness',
  'scheduler_status',
  'usage_report',
  'search_knowledge',
  'diagnose_transition',
  'dry_run_transition',
  'verify_inscription',
  // memory
  'memory_write',
  'memory_recall',
  'protocol_write',
  'protocol_tail',
  'application_list',
  'application_describe',
  'application_action',
  'memory_link',
  'memory_graph',
  'domain_memory_write',
  'domain_memory_recall',
  // net building
  'deploy_template',
  'create_net',
  'add_place',
  'add_transition',
  'add_transitions',
  'delete_transition',
  'delete_net',
  'delete_tokens',
  'set_schedule',
  'set_transition_credentials',
  'list_transition_credentials',
  'delete_transition_credentials',
  'fire_once',
  'start_transition',
  'stop_transition',
  'pause_model',
  'resume_model',
  'host_transition',
  'unhost_transition',
  // external fires — the host model is the LLM
  'list_external_fires',
  'set_external',
  'prepare_external_fire',
  'complete_external_fire',
  'abandon_external_fire',
  'create_persona',
  'spawn_persona',
  'scaffold_tool_net',
  'invoke_tool_net',
  'invoke_agent',
  'start_domain_expert',
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

  it('native catalog schemas keep param metadata + expose the placeId alias on place tools', async () => {
    const client = await connectedClient(makeConfig());
    const { tools } = await client.listTools();
    const qt = tools.find((t) => t.name === 'QUERY_TOKENS');
    const props = (qt!.inputSchema as any).properties;
    expect(Object.keys(props).length).toBeGreaterThan(0);
    // Descriptions flow through from the CLI schema.
    expect(props.placePath?.description).toBeTruthy();
    // Place tools advertise the `placeId` alias, and `placePath` is no longer strictly required —
    // the ToolExecutor handler accepts either (catalog.ts), so an MCP caller can use the same
    // `placeId` the curated tools take without a schema-validation rejection.
    expect(Object.keys(props)).toContain('placeId');
    expect((qt!.inputSchema as any).required ?? []).not.toContain('placePath');
    // Required-ness is still preserved where the handler genuinely needs a param (transitionId,
    // netId, …) — the relaxation is scoped to placePath only.
    const anyRequired = tools.some((t) => ((t.inputSchema as any).required?.length ?? 0) > 0);
    expect(anyRequired).toBe(true);
  });

  it('curated mode hides the native catalog without changing the lowercase product surface', async () => {
    const client = await connectedClient(makeConfig({ nativeTools: 'curated' }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(CURATED);
    expect(names).not.toContain('QUERY_TOKENS');
  });

  it('schedule, FOREACH, batch, and safe-fire schemas advertise the hardened controls', async () => {
    const client = await connectedClient(makeConfig({ nativeTools: 'curated' }));
    const { tools } = await client.listTools();
    const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as any).properties;
    expect(props('add_transition')).toMatchObject({
      timezone: expect.any(Object),
      batchSize: expect.any(Object),
      llmMode: expect.any(Object),
      binary: expect.any(Object),
    });
    expect(props('spawn_persona').execution).toBeTruthy();
    expect(props('set_schedule').timezone).toBeTruthy();
    expect(props('fire_once').preserveRunning).toBeTruthy();
    expect(props('add_transitions').transitions).toBeTruthy();
    expect(props('delete_tokens').arcql).toBeTruthy();
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
      ['application_describe', 'application_list', 'domain_memory_recall', 'event_trail', 'list_executors', 'list_external_fires', 'list_models', 'list_transitions', 'llm_health', 'memory_graph', 'memory_recall', 'net_overview', 'net_stats', 'protocol_tail', 'query_tokens', 'readiness', 'scheduler_status', 'search_knowledge', 'usage_report'].sort(),
    );
  });

  it('server delivers teaching instructions at initialize', async () => {
    const client = await connectedClient(makeConfig());
    expect(client.getInstructions()).toMatch(/persona agents with memory that runs/i);
    expect(client.getInstructions()).toMatch(/ArcQL/);
    expect(client.getInstructions()).toMatch(/Interview.*Goals/i);
  });

  it('teaches clients to structure related data as nets with typed link transitions', async () => {
    const client = await connectedClient(makeConfig());
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toMatch(/semantic net, not a bag of places/i);
    expect(instructions).toMatch(/EVERY MCP deployment and transport \(Desktop, stdio, HTTP\/server\)/);
    expect(instructions).toMatch(/collection of places is not a finished model/i);
    expect(instructions).toMatch(/directional, typed `kind:"link"` transition/i);
    expect(instructions).toMatch(/context.*not isolated\s+containers/is);
    expect(instructions).toMatch(/Links express semantics\s+only: they never fire or move tokens/i);

    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'create_net')?.description).toMatch(/preferred home for related durable stores/i);
    expect(tools.find((tool) => tool.name === 'add_place')?.description).toMatch(/should not remain disconnected/i);
    expect(tools.find((tool) => tool.name === 'add_transition')?.description).toMatch(/Prefer link transitions/i);

    const write = tools.find((tool) => tool.name === 'memory_write');
    const linkItem = (write!.inputSchema as any).properties.links.items;
    expect(linkItem.properties.relation).toBeTruthy();
  });

  it('keeps the semantic-net default independent of MCP transport and tool-surface mode', async () => {
    const variants: Array<Partial<McpConfig>> = [
      { transport: 'stdio', nativeTools: 'all' },
      { transport: 'http', httpToken: 'test-token', nativeTools: 'curated' },
      { transport: 'http', httpToken: 'test-token', nativeTools: 'all', mode: 'readonly' },
    ];
    for (const variant of variants) {
      const client = await connectedClient(makeConfig(variant));
      expect(client.getInstructions()).toMatch(/EVERY MCP deployment and transport/);
      expect(client.getInstructions()).toMatch(/directional, typed `kind:"link"` transition/);
      await client.close();
    }
  });

  it('teaches every new MCP session that STANDBY executors can serve command lanes', async () => {
    const client = await connectedClient(makeConfig());
    expect(client.getInstructions()).toMatch(/READY or STANDBY can\s+serve it/i);

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'readiness')?.description).toMatch(/STANDBY.*eligible/i);
    expect(tools.find((t) => t.name === 'list_executors')?.description).toMatch(/STANDBY.*command-capable/i);
  });

  it('resources include the knowledge base and catalogs', async () => {
    const client = await connectedClient(makeConfig());
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('agenticnets://models');
    expect(uris).toContain('agenticnets://templates');
    expect(uris).toContain('agenticnets://docs/starter-patterns');
    const doc = await client.readResource({ uri: 'agenticnets://docs/arcql' });
    expect((doc.contents[0] as any).text).toMatch(/DOUBLE equals/);
  });

  it('prompts are registered', async () => {
    const client = await connectedClient(makeConfig());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(
      [
        'capture-session',
        'design-persona-team',
        'debug-net',
        'monitor-personas',
        'review-current-model',
        'setup-working-memory',
        'spawn-worker',
        'start-safe-product-team',
        'work-dev-team-backlog',
        'work-external-fires',
      ].sort(),
    );
  });

  it('Safe Product Team playbook preserves observability and side-effect boundaries', async () => {
    const client = await connectedClient(makeConfig());
    const prompt = await client.getPrompt({
      name: 'start-safe-product-team',
      arguments: { product: 'A release notes service', repository: '/work/release-notes' },
    });
    const text = prompt.messages.map((message: any) => message.content.text ?? '').join('\n');
    expect(text).toMatch(/p-protocol/);
    expect(text).toMatch(/NetHub agent package/);
    expect(text).toMatch(/reasoning-only/);
    expect(text).toMatch(/machine-readable status token/);
    expect(text).toMatch(/event trail remains the complete low-level history/);
    expect(text).toMatch(/Developer.*forbids commit.*push.*deploy/);
    expect(text).toMatch(/explicit approval token before commit\/push\/deploy/);
    expect(text).toMatch(/set_external for connected-client lanes/);
    expect(text).toMatch(/start_transition only for server- or CLI-backed resident lanes/);
  });

  it('Model Steward prompt is domain-neutral, evidence-based, and advisory-only', async () => {
    const client = await connectedClient(makeConfig());
    const prompt = await client.getPrompt({
      name: 'review-current-model',
      arguments: { scope: 'net', target: 'claims-processing', question: 'Where does work wait?' },
    });
    const text = prompt.messages.map((message: any) => message.content.text ?? '').join('\n');
    expect(text).toMatch(/docs\/model-steward/);
    expect(text).toMatch(/hub_search.*model-steward/);
    expect(text).toMatch(/observed facts from inference/);
    expect(text).toMatch(/apply nothing/);
    expect(text).toMatch(/protocol_write/);
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
