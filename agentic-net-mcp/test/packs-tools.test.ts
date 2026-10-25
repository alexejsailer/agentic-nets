/**
 * Regression pins for the whole-net install tools and the net_overview
 * not-found guard — every case here was a real defect found by testing the
 * committed build against staging on 2026-08-30.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

function config(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp',
    nodeHost: 'node-host:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-packs-test.json',
    persistAllowlist: false, nativeTools: 'curated',
    ...overrides,
  } as McpConfig;
}

type Handler = (tool: string, params: any) => any;

/** Connect a client whose executor is a scripted fake; `calls` records every tool invocation. */
async function clientWith(
  handler: Handler,
  cfg: McpConfig = config(),
  master?: (method: string, path: string, body?: any, query?: any) => any,
) {
  const ctx = new AppContext(cfg);
  const calls: Array<{ tool: string; params: any }> = [];
  if (master) {
    (ctx.client as any).masterApi = async (method: string, path: string, body?: any, query?: any) =>
      master(method, path, body, query);
  }
  (ctx as any).executorFor = () => ({
    execute: async (tool: string, params: any) => {
      calls.push({ tool, params });
      return handler(tool, params) ?? { success: true, data: {} };
    },
  });
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, calls };
}

const textOf = (res: any) => res.content?.find((c: any) => c.type === 'text')?.text ?? '';
const dataOf = (res: any) => JSON.parse(textOf(res));

const MINIMAL_SOURCE = {
  net: 'n1',
  session: 'agent-n1',
  transitions: [
    {
      id: 't-1', kind: 'map', label: 'one',
      reads: { input: 'p-in' }, writes: { out: 'p-out' },
      template: { a: '${input.data.a}' },
    },
  ],
};

describe('install_net', () => {
  it('rejects an invalid source BEFORE touching the server', async () => {
    const { client, calls } = await clientWith(() => ({ success: true, data: {} }));
    const res: any = await client.callTool({
      name: 'install_net',
      arguments: { source: { net: 'bad', transitions: [{ id: 't', kind: 'map', label: 'x', reads: { i: 'p' }, writes: { o: 'q' } }] } },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/needs a template/);
    expect(calls, 'a rejected source must not mutate anything').toHaveLength(0);
  });

  it('normalizes hosts and agent modelId to the TARGET model', async () => {
    const withAgent = {
      net: 'n2', session: 'agent-n2',
      transitions: [
        {
          id: 't-a', kind: 'agent', label: 'a',
          reads: { task: 'p-task' }, writes: { out: 'p-o' },
          agent: { nl: 'decide', tier: 'medium' },
        },
      ],
      model: 'someone-elses-model',
    };
    const { client, calls } = await clientWith((tool) =>
      tool === 'QUERY_TOKENS' ? { success: true, data: { results: [] } } : { success: true, data: {} },
    );
    await client.callTool({ name: 'install_net', arguments: { source: withAgent } });
    const insc = calls.find((c) => c.tool === 'SET_INSCRIPTION')!.params.inscription;
    expect(insc.action.modelId).toBe('m1');
    expect(insc.presets.task.host).toBe('m1@node-host:8080');
    expect(insc.postsets.out.host).toBe('m1@node-host:8080');
  });

  it('never blind-reseeds a place that already holds tokens', async () => {
    const { client, calls } = await clientWith((tool, params) => {
      if (tool === 'QUERY_TOKENS') {
        const full = String(params.placePath).endsWith('p-cfg');
        return { success: true, data: { results: full ? [{ id: 'existing' }] : [] } };
      }
      return { success: true, data: {} };
    });
    const res: any = await client.callTool({
      name: 'install_net',
      arguments: { source: MINIMAL_SOURCE, seeds: { 'p-cfg': [{ k: 'v' }], 'p-fresh': [{ k: 'v' }] } },
    });
    const out = dataOf(res);
    expect(out.installed.skippedSeeds).toEqual(['p-cfg']);
    expect(out.installed.seeded).toEqual(['p-fresh']);
    const seedWrites = calls.filter((c) => c.tool === 'CREATE_TOKEN' && String(c.params.placePath).includes('p-cfg'));
    expect(seedWrites).toHaveLength(0);
  });

  it('replaces an existing agent-manifest leaf instead of blind-creating it', async () => {
    const { client, calls } = await clientWith((tool) =>
      tool === 'QUERY_TOKENS' ? { success: true, data: { results: [] } } : { success: true, data: {} },
    );
    await client.callTool({
      name: 'install_net',
      arguments: { source: MINIMAL_SOURCE, manifest: { name: 'p', entry: { inboxPlaceId: 'p-in' } } },
    });
    const del = calls.findIndex((c) => c.tool === 'DELETE_TOKEN' && c.params.tokenName === 'agent-manifest');
    const create = calls.findIndex((c) => c.tool === 'CREATE_TOKEN' && c.params.name === 'agent-manifest');
    expect(del).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(del); // delete-then-create, in that order
  });

  it('remaps every owned id when a suffix is given', async () => {
    const { client, calls } = await clientWith((tool) =>
      tool === 'QUERY_TOKENS' ? { success: true, data: { results: [] } } : { success: true, data: {} },
    );
    await client.callTool({ name: 'install_net', arguments: { source: MINIMAL_SOURCE, suffix: '-c2' } });
    const insc = calls.find((c) => c.tool === 'SET_INSCRIPTION')!.params.inscription;
    expect(insc.id).toBe('t-1-c2');
    expect(insc.presets.input.placeId).toBe('p-in-c2');
    expect(insc.postsets.out.placeId).toBe('p-out-c2');
    expect(calls.find((c) => c.tool === 'CREATE_NET')!.params.netId).toBe('n1-c2');
  });

  const noTokens = (tool: string) =>
    tool === 'QUERY_TOKENS' ? { success: true, data: { results: [] } } : { success: true, data: {} };
  const notRunning = () => null;

  it('start:false installs stopped and names the lanes it would have started', async () => {
    const { client, calls } = await clientWith(noTokens, config(), notRunning);
    const res: any = await client.callTool({ name: 'install_net', arguments: { source: MINIMAL_SOURCE, start: false } });
    const data = dataOf(res);
    expect(data.installed.started).toBe(0);
    expect(data.installed.startable).toEqual(['t-1']);
    expect(calls.some((c) => c.tool === 'START_TRANSITION')).toBe(false);
  });

  it('an external place is drawn and ensured but never renamed by suffix or seeded', async () => {
    const source = {
      ...MINIMAL_SOURCE,
      places: { 'p-in': { label: 'Shared orders', external: true } },
    };
    const { client, calls } = await clientWith(noTokens, config(), notRunning);
    const res: any = await client.callTool({
      name: 'install_net',
      arguments: { source, suffix: '-c2', seeds: { 'p-in': [{ a: 1 }], 'p-out': [{ b: 2 }] } },
    });
    const data = dataOf(res);
    const insc = calls.find((c) => c.tool === 'SET_INSCRIPTION')!.params.inscription;
    expect(insc.presets.input.placeId).toBe('p-in');          // the boundary keeps its id
    expect(insc.postsets.out.placeId).toBe('p-out-c2');       // owned places are still suffixed
    expect(calls.filter((c) => c.tool === 'CREATE_PLACE').map((c) => c.params.placeId)).toEqual(['p-in', 'p-out-c2']);
    expect(calls.filter((c) => c.tool === 'CREATE_RUNTIME_PLACE').map((c) => c.params.placeId)).toContain('p-in');
    const seededPlaces = calls.filter((c) => c.tool === 'CREATE_TOKEN').map((c) => c.params.placePath);
    expect(seededPlaces).toEqual(['root/workspace/places/p-out-c2']);
    expect(data.installed.externalPlaces).toEqual(['p-in']);
    expect(data.installed.externalSeedsSkipped).toEqual(['p-in']);
  });

  it('externalPlaces at the top level works the same way', async () => {
    const { client, calls } = await clientWith(noTokens, config(), notRunning);
    await client.callTool({
      name: 'install_net',
      arguments: { source: { ...MINIMAL_SOURCE, externalPlaces: ['p-out'] }, suffix: '-x' },
    });
    const insc = calls.find((c) => c.tool === 'SET_INSCRIPTION')!.params.inscription;
    expect(insc.presets.input.placeId).toBe('p-in-x');
    expect(insc.postsets.out.placeId).toBe('p-out');
  });

  it('a failure mid-install reports what was created and where it stopped', async () => {
    const { client } = await clientWith(
      (tool) => (tool === 'CREATE_ARC' ? { success: false, error: 'arc refused' } : noTokens(tool)),
      config(),
      notRunning,
    );
    const res: any = await client.callTool({ name: 'install_net', arguments: { source: MINIMAL_SOURCE } });
    expect(res.isError).toBe(true);
    const data = dataOf(res);
    expect(data.code).toBe('install-incomplete');
    expect(data.progress.failedAt).toMatch(/^CREATE_ARC a-n1-01$/);
    expect(data.progress.created.net).toBe(true);
    expect(data.progress.created.places).toEqual(['p-in', 'p-out']);
    expect(data.progress.created.transitions).toEqual(['t-1']);
    expect(data.progress.created.arcs).toEqual([]);
    expect(data.progress.created.inscriptions).toEqual([]);
  });

  it('a running lane is stopped before its inscription is replaced', async () => {
    const order: string[] = [];
    const { client, calls } = await clientWith(
      (tool, params) => {
        if (tool === 'STOP_TRANSITION' || tool === 'SET_INSCRIPTION') order.push(`${tool} ${params.transitionId}`);
        return noTokens(tool);
      },
      config(),
      (_m, path) => (path === '/transitions/t-1/status' ? { status: 'running' } : null),
    );
    const res: any = await client.callTool({ name: 'install_net', arguments: { source: MINIMAL_SOURCE, start: false } });
    const data = dataOf(res);
    expect(order).toEqual(['STOP_TRANSITION t-1', 'SET_INSCRIPTION t-1']);
    expect(data.installed.stopped).toEqual(['t-1']);
    expect(calls.some((c) => c.tool === 'START_TRANSITION')).toBe(false);
  });
});

describe('uninstall_net', () => {
  it('tolerates already-absent elements and still untags (idempotent teardown)', async () => {
    const { client, calls } = await clientWith((tool) => {
      if (tool === 'DELETE_TRANSITION') throw new Error('not found in path');
      if (tool === 'DELETE_NET') return { success: false, error: 'gone' };
      return { success: true, data: {} };
    });
    const res: any = await client.callTool({ name: 'uninstall_net', arguments: { source: MINIMAL_SOURCE } });
    expect(res.isError).toBeFalsy();
    const out = dataOf(res).uninstalled;
    expect(out.transitionsRemoved).toBe(0);
    expect(out.alreadyAbsent).toBe(1);
    expect(out.netDeleted).toBe(false);
    expect(out.untagged).toEqual(['agents', 'capability-pack']);
    const untag = calls.find((c) => c.tool === 'TAG_SESSION');
    expect(untag?.params.mode).toBe('remove');
  });

  it('untag:[] leaves the session tags alone', async () => {
    const { client, calls } = await clientWith(() => ({ success: true, data: {} }));
    await client.callTool({ name: 'uninstall_net', arguments: { source: MINIMAL_SOURCE, untag: [] } });
    expect(calls.find((c) => c.tool === 'TAG_SESSION')).toBeUndefined();
  });

  it('compiles for teardown even when the agent charter is unavailable', async () => {
    const agentSource = {
      net: 'n3',
      transitions: [
        { id: 't-a', kind: 'agent', label: 'a', reads: { t: 'p-t' }, writes: { o: 'p-o' }, agent: { charter: 'gone.md' } },
      ],
    };
    const { client, calls } = await clientWith(() => ({ success: true, data: {} }));
    const res: any = await client.callTool({ name: 'uninstall_net', arguments: { source: agentSource } });
    expect(res.isError, 'teardown must not need the prompt text').toBeFalsy();
    expect(calls.some((c) => c.tool === 'DELETE_TRANSITION' && c.params.transitionId === 't-a')).toBe(true);
  });
});

describe('net_overview netId guard', () => {
  const overview = (counts: any) => ({ success: true, data: { netId: 'x', ...counts } });

  it('errors on a netId the session does not contain (instead of a plausible empty shell)', async () => {
    const { client } = await clientWith((tool) => {
      if (tool === 'GET_NET_OVERVIEW') return overview({ placeCount: 0, transitionCount: 0, arcCount: 0 });
      if (tool === 'LIST_SESSION_NETS') return { success: true, data: [{ name: 'real-net' }] };
      return { success: true, data: {} };
    });
    const res: any = await client.callTool({ name: 'net_overview', arguments: { netId: 'typo-net' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not exist/);
    expect(textOf(res)).toMatch(/real-net/); // tells the caller what IS there
  });

  it('treats an empty-but-successful session listing as authoritative', async () => {
    const { client } = await clientWith((tool) => {
      if (tool === 'GET_NET_OVERVIEW') return overview({ placeCount: 0, transitionCount: 0, arcCount: 0 });
      if (tool === 'LIST_SESSION_NETS') return { success: true, data: [] };
      return { success: true, data: {} };
    });
    const res: any = await client.callTool({ name: 'net_overview', arguments: { netId: 'ghost' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/\(none\)/);
  });

  it('reports a genuinely empty but EXISTING net as empty, not missing', async () => {
    const { client } = await clientWith((tool) => {
      if (tool === 'GET_NET_OVERVIEW') return overview({ placeCount: 0, transitionCount: 0, arcCount: 0 });
      if (tool === 'LIST_SESSION_NETS') return { success: true, data: [{ netId: 'fresh' }] };
      return { success: true, data: {} };
    });
    const res: any = await client.callTool({ name: 'net_overview', arguments: { netId: 'fresh' } });
    expect(res.isError).toBeFalsy();
    expect(dataOf(res)).toMatchObject({ empty: true });
  });

  it('stays inconclusive (never falsely asserts existence) when the listing fails', async () => {
    const { client } = await clientWith((tool) => {
      if (tool === 'GET_NET_OVERVIEW') return overview({ placeCount: 0, transitionCount: 0, arcCount: 0 });
      if (tool === 'LIST_SESSION_NETS') return { success: false, error: 'boom' };
      return { success: true, data: {} };
    });
    const res: any = await client.callTool({ name: 'net_overview', arguments: { netId: 'maybe' } });
    expect(res.isError).toBeFalsy();
    expect(dataOf(res).note).toMatch(/unverified/);
  });

  it('passes a populated net straight through', async () => {
    const { client, calls } = await clientWith((tool) =>
      tool === 'GET_NET_OVERVIEW' ? overview({ placeCount: 3, transitionCount: 2, arcCount: 4 }) : { success: true, data: {} },
    );
    const res: any = await client.callTool({ name: 'net_overview', arguments: { netId: 'busy' } });
    expect(dataOf(res)).toMatchObject({ placeCount: 3 });
    expect(calls.some((c) => c.tool === 'LIST_SESSION_NETS'), 'no extra lookup for a non-empty net').toBe(false);
  });
});
