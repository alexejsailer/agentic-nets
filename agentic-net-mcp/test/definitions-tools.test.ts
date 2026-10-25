/**
 * Net definitions and their build protocol over MCP. A stubbed master pins the request shapes
 * (every path carries ?modelId=), the derived nextActions, revise bookkeeping, activation on
 * complete, structured 409 codes, and the readonly surface.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';
import { definitionReadiness, nextActions } from '../src/tools/definitions.js';
import { relationLines, summarize } from '../src/tools/explorer.js';

function config(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp',
    nodeHost: 'localhost:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-definitions-test.json',
    persistAllowlist: false, nativeTools: 'curated',
    ...overrides,
  } as McpConfig;
}

interface Call { method: string; path: string; body?: any }

function gatewayError(status: number, body: any, path = 'POST /x') {
  return Object.assign(new Error(`Gateway ${status}`), {
    name: 'GatewayError', status, body: JSON.stringify(body), path,
  });
}

async function connect(route: (c: Call) => any, overrides: Partial<McpConfig> = {}) {
  const ctx = new AppContext(config(overrides));
  const calls: Call[] = [];
  (ctx.client as any).masterApi = async (method: string, path: string, body?: any) => {
    const c = { method, path, body };
    calls.push(c);
    return route(c);
  };
  const server = createServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, calls };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
}

const CATALOGUE = {
  modelId: 'm1',
  nets: [
    { key: 'product::overview', title: 'Product overview', description: 'The product', depth: 0 },
    {
      key: 'identity::risk', title: 'Authentication analysis', description: 'Explain auth risks', depth: 1,
      placeCount: 0, transitionCount: 0, definitionStatus: 'draft',
      parent: { ref: { sessionId: 'product', netId: 'overview' }, elementId: 't-risk', elementType: 'transition' },
    },
    { key: 'identity::login', title: 'Login flow', description: 'Sessions', depth: 0, definitionStatus: 'ready' },
  ],
  definitions: [
    { ref: { sessionId: 'identity', netId: 'risk' }, key: 'identity::risk', status: 'draft', revision: 2, interactions: 'reads findings' },
    { ref: { sessionId: 'identity', netId: 'login' }, key: 'identity::login', status: 'ready', revision: 1 },
  ],
};

function detail(over: any = {}) {
  return {
    definition: {
      ref: { sessionId: 'identity', netId: 'risk' }, key: 'identity::risk',
      schemaVersion: '1', status: 'ready', revision: 2, interactions: 'reads findings',
      history: [{ revision: 1 }, { revision: 2 }],
      ...over.definition,
    },
    net: { ref: { sessionId: 'identity', netId: 'risk' }, description: 'Explain auth risks' },
    builds: over.builds ?? [],
    questions: over.questions ?? { open: [], answered: [] },
    interview: { installed: true, version: '1.4.0', supportsSubjects: true },
  };
}

describe('nextActions', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  it('draft → mark ready; ready → request a build', () => {
    expect(nextActions(detail({ definition: { status: 'draft' } }), now)[0]).toMatch(/mark ready/);
    expect(nextActions(detail(), now)[0]).toMatch(/request a build/);
  });
  it('queued build → claim it', () => {
    const d = detail({ builds: [{ buildId: 'b-1', attempt: { state: 'queued' } }] });
    expect(nextActions(d, now)).toEqual([expect.stringMatching(/claim build b-1/)]);
  });
  it('awaiting answers with open questions → answer them; without → claim again', () => {
    const waiting = { buildId: 'b-1', attempt: { state: 'awaiting-answers' } };
    expect(nextActions(detail({ builds: [waiting], questions: { open: [{}, {}], answered: [] } }), now)[0])
      .toMatch(/answer 2 open questions/);
    expect(nextActions(detail({ builds: [waiting] }), now)[0]).toMatch(/answers are in: claim build b-1/);
  });
  it('active lease → held; expired lease → claim to resume', () => {
    const held = { buildId: 'b-1', attempt: { state: 'building', owner: 'bob', leaseExpiresAt: '2026-10-10T12:05:00Z' } };
    const lapsed = { buildId: 'b-1', attempt: { state: 'building', owner: 'bob', leaseExpiresAt: '2026-10-10T11:00:00Z' } };
    expect(nextActions(detail({ builds: [held] }), now)[0]).toMatch(/held by bob/);
    expect(nextActions(detail({ builds: [lapsed] }), now)[0]).toMatch(/lease expired/);
  });
  it('realized with a newer revision → changes pending', () => {
    const d = detail({ definition: { status: 'realized', revision: 3, realizedRevision: 2 } });
    expect(nextActions(d, now)[0]).toMatch(/changes pending/);
  });
});

describe('definition readers', () => {
  it('list_net_definitions joins definitions with their nets and filters', async () => {
    const { client, calls } = await connect(() => CATALOGUE);
    const all = await call(client, 'list_net_definitions');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/explorer/m1/catalogue?modelId=m1' });
    expect(all.data.total).toBe(2);
    expect(all.data.definitions[0]).toMatchObject({
      key: 'identity::risk', title: 'Authentication analysis', status: 'draft', revision: 2,
      depth: 1, parent: 'product::overview#t-risk',
    });
    const ready = await call(client, 'list_net_definitions', { status: 'ready' });
    expect(ready.data.definitions.map((d: any) => d.key)).toEqual(['identity::login']);
    const byQuery = await call(client, 'list_net_definitions', { query: 'findings' });
    expect(byQuery.data.definitions.map((d: any) => d.key)).toEqual(['identity::risk']);
  });

  it('list_net_definitions detail:"full" adds open-question counts per definition', async () => {
    const { client, calls } = await connect((c) => (c.path.includes('/catalogue')
      ? CATALOGUE
      : detail({ questions: { open: [{ promptId: 'q1' }], answered: [] } })));
    const full = await call(client, 'list_net_definitions', { detail: 'full' });
    expect(full.data.definitions.every((d: any) => d.openQuestions === 1)).toBe(true);
    expect(calls.map((c) => c.path)).toContain('/explorer/m1/definitions/identity/risk?modelId=m1');
  });

  it('get_net_definition returns builds, questions, askWith subject and nextActions', async () => {
    const d = detail({ builds: [{ buildId: 'b-7', revision: 2, attempt: { state: 'awaiting-answers', leaseGeneration: 3 } }], questions: { open: [{ promptId: 'q1' }], answered: [] } });
    const { client, calls } = await connect(() => d);
    const out = await call(client, 'get_net_definition', { sessionId: 'identity', netId: 'risk' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/explorer/m1/definitions/identity/risk?modelId=m1' });
    expect(out.data.key).toBe('identity::risk');
    expect(out.data.openBuild).toMatchObject({ buildId: 'b-7', state: 'awaiting-answers', leaseGeneration: 3 });
    expect(out.data.questions.open).toHaveLength(1);
    expect(out.data.askWith.subject).toEqual({
      subjectKind: 'net-definition', subjectKey: 'identity::risk', subjectRevision: 2, refs: { 'explorer.build': 'b-7' }, buildId: 'b-7',
    });
    expect(out.data.nextActions[0]).toMatch(/answer 1 open question/);
  });
});

describe('definition writers', () => {
  it('create posts name, description, definition fields and parent', async () => {
    const { client, calls } = await connect(() => ({ ref: { sessionId: 'identity', netId: 'risk' }, key: 'identity::risk', parentAttached: true }));
    const out = await call(client, 'update_net_definition', {
      action: 'create', sessionId: 'identity', name: 'Authentication analysis', description: 'Explain auth risks',
      interactions: 'reads findings', proposedPorts: [{ placeId: 'p-findings', role: 'input' }], layerAbove: 'product',
      parent: { sessionId: 'product', netId: 'overview', elementId: 't-risk' },
    });
    expect(out.isError).toBe(false);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/explorer/m1/definitions?modelId=m1' });
    expect(calls[0].body).toEqual({
      sessionId: 'identity', name: 'Authentication analysis', description: 'Explain auth risks',
      definition: { interactions: 'reads findings', proposedPorts: [{ placeId: 'p-findings', role: 'input' }], layerAbove: 'product' },
      parent: { elementType: 'transition', sessionId: 'product', netId: 'overview', elementId: 't-risk' },
    });
  });

  it('revise reads first, increments the revision, appends history, and keeps the status', async () => {
    const { client, calls } = await connect((c) => (c.method === 'GET' ? detail() : { updated: true }));
    const out = await call(client, 'update_net_definition', {
      action: 'revise', sessionId: 'identity', netId: 'risk', interactions: 'reads findings and logs', description: 'Explain risks, with logs', by: 'alex',
    });
    expect(out.data).toMatchObject({ action: 'revise', revision: 3, status: 'ready' });
    const designtime = calls.find((c) => c.path === '/designtime/nets');
    expect(designtime?.body).toEqual({ modelId: 'm1', sessionId: 'identity', netId: 'risk', description: 'Explain risks, with logs' });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/explorer/m1/nets/identity/risk/organization?modelId=m1');
    const def = put?.body.definition;
    expect(def).not.toHaveProperty('ref');
    expect(def).not.toHaveProperty('key');
    expect(def).toMatchObject({ revision: 3, status: 'ready', interactions: 'reads findings and logs', schemaVersion: '1' });
    expect(def.history).toHaveLength(3);
    expect(def.history[2]).toMatchObject({ revision: 3, by: 'alex', description: 'Explain risks, with logs', interactions: 'reads findings and logs' });
  });

  it('ready keeps the revision and sets status ready', async () => {
    const { client, calls } = await connect((c) => (c.method === 'GET' ? detail({ definition: { status: 'draft' } }) : {}));
    const out = await call(client, 'update_net_definition', { action: 'ready', sessionId: 'identity', netId: 'risk' });
    expect(out.data).toMatchObject({ status: 'ready', revision: 2 });
    expect(calls.find((c) => c.method === 'PUT')?.body.definition).toMatchObject({ status: 'ready', revision: 2 });
  });

  it('request_build posts policy, requester and idempotency key', async () => {
    const { client, calls } = await connect(() => ({ buildId: 'b-1', state: 'queued' }));
    await call(client, 'update_net_definition', {
      action: 'request_build', sessionId: 'identity', netId: 'risk', policy: { activate: true }, by: 'alex', idempotencyKey: 'k1',
    });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/explorer/m1/builds?modelId=m1' });
    expect(calls[0].body).toEqual({ sessionId: 'identity', netId: 'risk', policy: { activate: true }, requestedBy: 'alex', idempotencyKey: 'k1' });
  });

  it('claim/renew/release map to the lease routes; claim can find the open build by definition', async () => {
    const { client, calls } = await connect((c) => (c.method === 'GET'
      ? detail({ builds: [{ buildId: 'b-9', attempt: { state: 'queued' } }] })
      : { leaseGeneration: 4 }));
    await call(client, 'claim_net_definition', { action: 'claim', owner: 'me', sessionId: 'identity', netId: 'risk', leaseSeconds: 300 });
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/explorer/m1/builds/b-9/claim?modelId=m1', body: { owner: 'me', leaseSeconds: 300 } });
    await call(client, 'claim_net_definition', { action: 'renew', owner: 'me', buildId: 'b-9', leaseGeneration: 4 });
    expect(calls[2]).toMatchObject({ path: '/explorer/m1/builds/b-9/renew?modelId=m1', body: { owner: 'me', leaseGeneration: 4 } });
    await call(client, 'claim_net_definition', { action: 'release', owner: 'me', buildId: 'b-9', leaseGeneration: 4, state: 'awaiting-answers' });
    expect(calls[3]).toMatchObject({ path: '/explorer/m1/builds/b-9/release?modelId=m1', body: { owner: 'me', leaseGeneration: 4, state: 'awaiting-answers' } });
    const missing = await call(client, 'claim_net_definition', { action: 'renew', owner: 'me', buildId: 'b-9' });
    expect(missing.isError).toBe(true);
    expect(missing.data.code).toBe('missing-field');
  });

  it('checkpoint, apply, fail and cancel map 1:1 to the build routes', async () => {
    const { client, calls } = await connect(() => ({ ok: true }));
    const fence = { buildId: 'b-1', owner: 'me', leaseGeneration: 2 };
    await call(client, 'record_net_build', { ...fence, action: 'checkpoint', state: 'planning', plan: { revision: 2, reusedPlaces: ['p-a'] } });
    expect(calls[0]).toMatchObject({ path: '/explorer/m1/builds/b-1/checkpoint?modelId=m1', body: { owner: 'me', leaseGeneration: 2, state: 'planning', plan: { revision: 2, reusedPlaces: ['p-a'] } } });
    await call(client, 'record_net_build', {
      ...fence, action: 'apply',
      places: { 'p-a': { label: 'A' } },
      transitions: { 't-x': { label: 'X', inscription: { kind: 'map' } } },
      remove: { transitions: ['t-old'] },
    });
    expect(calls[1]).toMatchObject({
      path: '/explorer/m1/builds/b-1/apply?modelId=m1',
      body: { owner: 'me', leaseGeneration: 2, places: { 'p-a': { label: 'A' } }, transitions: { 't-x': { label: 'X', inscription: { kind: 'map' } } }, remove: { transitions: ['t-old'] } },
    });
    await call(client, 'record_net_build', { ...fence, action: 'fail', error: 'no access', evidence: ['log'] });
    expect(calls[2]).toMatchObject({ path: '/explorer/m1/builds/b-1/fail?modelId=m1', body: { owner: 'me', leaseGeneration: 2, error: 'no access', evidence: ['log'] } });
    await call(client, 'record_net_build', { buildId: 'b-1', action: 'cancel', requestedBy: 'alex' });
    expect(calls[3]).toMatchObject({ path: '/explorer/m1/builds/b-1/cancel?modelId=m1', body: { requestedBy: 'alex' } });
  });

  it('complete starts the listed transitions only when the policy says activate', async () => {
    const activating = await connect((c) => (c.path.includes('/complete')
      ? { build: { state: 'succeeded' }, activation: { activate: true, transitionIds: ['t-a', 't-b'] } }
      : { success: true }));
    const out = await call(activating.client, 'record_net_build', {
      buildId: 'b-1', owner: 'me', leaseGeneration: 2, action: 'complete', verification: { passed: true, evidence: ['dry-run ok'] },
    });
    expect(activating.calls[0].body).toEqual({ owner: 'me', leaseGeneration: 2, verification: { passed: true, evidence: ['dry-run ok'] } });
    expect(activating.calls.slice(1).map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/transitions/t-a/start', { modelId: 'm1' }],
      ['POST', '/transitions/t-b/start', { modelId: 'm1' }],
    ]);
    expect(out.data.started).toEqual([{ transitionId: 't-a', started: true }, { transitionId: 't-b', started: true }]);

    const stopped = await connect(() => ({ build: { state: 'succeeded' }, activation: { activate: false, transitionIds: ['t-a'] } }));
    const kept = await call(stopped.client, 'record_net_build', { buildId: 'b-1', owner: 'me', leaseGeneration: 2, action: 'complete' });
    expect(stopped.calls).toHaveLength(1);
    expect(kept.data.started).toEqual([]);
  });

  it('a 409 from master surfaces as a structured error carrying its code', async () => {
    const { client } = await connect(() => {
      throw gatewayError(409, { error: 'lease generation 2 is stale; current is 3', code: 'lease-lost', currentGeneration: 3 });
    });
    const out = await call(client, 'record_net_build', { buildId: 'b-1', owner: 'me', leaseGeneration: 2, action: 'apply', places: {} });
    expect(out.isError).toBe(true);
    expect(out.data).toMatchObject({ code: 'lease-lost', status: 409, currentGeneration: 3 });
    expect(out.data.error).toMatch(/stale/);
  });

  it('missing owner or lease on a fenced action is refused before calling master', async () => {
    const { client, calls } = await connect(() => ({}));
    const out = await call(client, 'record_net_build', { buildId: 'b-1', action: 'checkpoint' });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe('missing-field');
    expect(calls).toHaveLength(0);
  });
});

describe('readonly mode', () => {
  it('registers the definition readers and none of the writers', async () => {
    const { client } = await connect(() => ({}), { mode: 'readonly' });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_net_definitions', 'get_net_definition']));
    for (const writer of ['update_net_definition', 'claim_net_definition', 'record_net_build']) {
      expect(names).not.toContain(writer);
    }
  });
});

describe('organization', () => {
  it('organize PUTs only the given fields to any net, including clears and a tag list', async () => {
    const { client, calls } = await connect(() => ({ updated: true }));
    const out = await call(client, 'update_net_definition', {
      action: 'organize', sessionId: 'shop', netId: 'checkout',
      domain: 'payments', tags: ['core', 'pci'], clearResponsible: true,
    });
    expect(out.isError).toBe(false);
    expect(calls).toHaveLength(1); // no definition read: organize works on any net
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/explorer/m1/nets/shop/checkout/organization?modelId=m1' });
    expect(calls[0].body).toEqual({ domain: 'payments', tags: ['core', 'pci'], clearResponsible: true });
    expect(out.data).toMatchObject({ action: 'organize', key: 'shop::checkout' });
  });

  it('organize without any field is refused before calling master', async () => {
    const { client, calls } = await connect(() => ({}));
    const out = await call(client, 'update_net_definition', { action: 'organize', sessionId: 'shop', netId: 'checkout' });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe('missing-field');
    expect(calls).toHaveLength(0);
  });

  it('create forwards layer, domain, responsible and tags', async () => {
    const { client, calls } = await connect(() => ({ key: 'identity::risk' }));
    await call(client, 'update_net_definition', {
      action: 'create', sessionId: 'identity', name: 'Risk', description: 'Explain risks',
      layer: 'service', domain: 'identity', responsible: 'alex', tags: ['auth'],
    });
    expect(calls[0].body).toMatchObject({ layer: 'service', domain: 'identity', responsible: 'alex', tags: ['auth'] });
  });

  it('explore_model summary carries organization and execution state, and query matches them', () => {
    const catalogue = {
      modelId: 'm1',
      nets: [
        { key: 'shop::checkout', title: 'Checkout', depth: 0, domain: 'payments', responsible: 'alex', tags: ['pci'],
          execution: { state: 'partial', executable: 2, counts: { running: 1, stopped: 1 } } },
        { key: 'shop::catalog', title: 'Catalog', depth: 0 },
      ],
    };
    const all = summarize(catalogue);
    expect(all.nets[0]).toMatchObject({ domain: 'payments', responsible: 'alex', tags: ['pci'], execution: 'partial' });
    expect(all.nets[1]).not.toHaveProperty('domain'); // older masters: nothing invented
    expect(all.hierarchy[0]).toMatch(/domain payments, responsible alex, tags pci, execution partial/);
    expect(summarize(catalogue, 'pci').nets.map((n: any) => n.key)).toEqual(['shop::checkout']);
    expect(summarize(catalogue, 'alex').nets.map((n: any) => n.key)).toEqual(['shop::checkout']);
  });
});

describe('readiness: definitions waiting for a builder', () => {
  it('counts ready, queued, awaiting answers and building, with a hint naming the prompt', () => {
    const r = definitionReadiness({
      definitions: [
        { key: 'a', status: 'ready' },
        { key: 'b', status: 'ready', activeBuild: 'b-1', latestBuildState: 'queued' },
        { key: 'c', status: 'ready', activeBuild: 'b-2', latestBuildState: 'awaiting-answers' },
        { key: 'd', status: 'ready', activeBuild: 'b-3', latestBuildState: 'building' },
        { key: 'e', status: 'draft' },
        { key: 'f', status: 'realized', latestBuildState: 'succeeded' },
      ],
    });
    expect(r).toMatchObject({ available: true, definitions: 6, ready: 1, queued: 1, awaitingAnswers: 1, building: 1 });
    expect(r.hint).toMatch(/realize-net-definition/);
    expect(definitionReadiness({ definitions: [{ status: 'draft' }] }).hint).toBeUndefined();
  });

  function readinessClient(catalogue: () => any) {
    const ctx = new AppContext(config());
    (ctx.client as any).masterApi = async (_m: string, path: string) => {
      if (path === '/explorer/m1/catalogue') return catalogue();
      if (path === '/llm/health') return { status: 'READY' };
      if (path === '/vault/health') return { status: 'DISABLED' };
      if (path === '/executors') return { executors: [] };
      if (path === '/models/m1/execution/status') return { transitions: [] };
      if (path === '/transitions/external/ready') return { transitions: [] };
      if (path === '/event-line/m1') return { events: [] };
      throw new Error(`unexpected master path ${path}`);
    };
    (ctx.client as any).nodeApi = async (_m: string, path: string) => {
      if (path === '/admin/models') return [{ modelId: 'm1', state: 'ACTIVE' }];
      return [{ name: 'places' }];
    };
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    return Promise.all([server.connect(st), client.connect(ct)]).then(() => client);
  }

  it('readiness reports the counts and the hint without becoming unready', async () => {
    const client = await readinessClient(() => ({ definitions: [{ key: 'a', status: 'ready' }] }));
    const out = await call(client, 'readiness');
    expect(out.data.netDefinitions).toMatchObject({ available: true, ready: 1 });
    expect((out.data.warnings ?? []).join(' ')).toMatch(/realize-net-definition/);
    expect(out.data.ready).toBe(true);
  });

  it('an older master or a failing catalogue never fails readiness', async () => {
    const client = await readinessClient(() => {
      throw Object.assign(new Error('Gateway 404'), { name: 'GatewayError', status: 404, body: '' });
    });
    const out = await call(client, 'readiness');
    expect(out.data.netDefinitions).toEqual({ available: false });
    expect(out.data.ready).toBe(true);
  });
});

describe('relations, archive, templates and references', () => {
  const REL_CATALOGUE = {
    modelId: 'm1',
    nets: [{ key: 'product::overview' }, { key: 'identity::risk' }, { key: 'identity::login' }],
    definitions: [],
    relations: [
      { fromKey: 'product::overview', relation: 'explains', to: { sessionId: 'identity', netId: 'risk' }, toKey: 'identity::risk', note: 'why', resolved: true },
      { fromKey: 'product::overview', relation: 'depends-on', to: { sessionId: 'identity', netId: 'login' }, toKey: 'identity::login', resolved: true },
      { fromKey: 'identity::risk', relation: 'references', toKey: 'identity::gone', resolved: false },
    ],
  };

  function relateRoute(c: Call) {
    return c.method === 'GET' ? REL_CATALOGUE : { updated: true };
  }

  it('relate add merges with the catalogue list (a repeat updates the note) and PUTs the whole list', async () => {
    const { client, calls } = await connect(relateRoute);
    const out = await call(client, 'update_net_definition', {
      action: 'relate', sessionId: 'product', netId: 'overview',
      relations: [
        { relation: 'explains', target: { sessionId: 'identity', netId: 'risk' }, note: 'why it matters' },
        { relation: 'references', target: { sessionId: 'identity', netId: 'login' } },
      ],
    });
    expect(out.isError).toBe(false);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/explorer/m1/catalogue?modelId=m1' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/explorer/m1/nets/product/overview/relations?modelId=m1');
    expect(put.body.relations).toEqual([
      { relation: 'explains', target: { sessionId: 'identity', netId: 'risk' }, note: 'why it matters' },
      { relation: 'depends-on', target: { sessionId: 'identity', netId: 'login' } },
      { relation: 'references', target: { sessionId: 'identity', netId: 'login' } },
    ]);
    expect(out.data).toMatchObject({ action: 'relate', key: 'product::overview', mode: 'add' });
  });

  it('relate remove drops a matching relation whatever its note; replace sends exactly the list without reading', async () => {
    const removing = await connect(relateRoute);
    await call(removing.client, 'update_net_definition', {
      action: 'relate', mode: 'remove', sessionId: 'product', netId: 'overview',
      relation: 'explains', target: { sessionId: 'identity', netId: 'risk' },
    });
    expect(removing.calls.find((c) => c.method === 'PUT')!.body.relations).toEqual([
      { relation: 'depends-on', target: { sessionId: 'identity', netId: 'login' } },
    ]);

    const replacing = await connect(relateRoute);
    await call(replacing.client, 'update_net_definition', {
      action: 'relate', mode: 'replace', sessionId: 'product', netId: 'overview', relations: [],
    });
    expect(replacing.calls).toHaveLength(1);
    expect(replacing.calls[0]).toMatchObject({ method: 'PUT', body: { relations: [] } });
  });

  it('relate without a relation is refused before calling master', async () => {
    const { client, calls } = await connect(relateRoute);
    const out = await call(client, 'update_net_definition', { action: 'relate', sessionId: 'product', netId: 'overview' });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe('missing-field');
    expect(calls).toHaveLength(0);
  });

  it('archive and unarchive keep the revision; archive is refused while a build is open', async () => {
    const archiving = await connect((c) => (c.method === 'GET' ? detail({ definition: { status: 'realized', revision: 4 } }) : { updated: true }));
    const archived = await call(archiving.client, 'update_net_definition', { action: 'archive', sessionId: 'identity', netId: 'risk' });
    expect(archived.data).toMatchObject({ action: 'archive', status: 'archived', revision: 4 });
    const put = archiving.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/explorer/m1/nets/identity/risk/organization?modelId=m1');
    expect(put.body.definition).toMatchObject({ status: 'archived', revision: 4, archivedFrom: 'realized' });
    expect(put.body.definition).not.toHaveProperty('key');

    // Restores the status it left.
    const restoring = await connect((c) => (c.method === 'GET' ? detail({ definition: { status: 'archived', archivedFrom: 'ready', revision: 4 } }) : { updated: true }));
    const restored = await call(restoring.client, 'update_net_definition', { action: 'unarchive', sessionId: 'identity', netId: 'risk' });
    expect(restored.data).toMatchObject({ action: 'unarchive', status: 'ready', revision: 4 });
    const restoredBody = restoring.calls.find((c) => c.method === 'PUT')!.body.definition;
    expect(restoredBody).toMatchObject({ status: 'ready', revision: 4 });
    expect(restoredBody).not.toHaveProperty('archivedFrom');

    // Archived elsewhere without the memory: realized when its revision was realized, else draft.
    const realized = await connect((c) => (c.method === 'GET' ? detail({ definition: { status: 'archived', revision: 4, realizedRevision: 4 } }) : { updated: true }));
    expect((await call(realized.client, 'update_net_definition', { action: 'unarchive', sessionId: 'identity', netId: 'risk' })).data.status).toBe('realized');
    const stale = await connect((c) => (c.method === 'GET' ? detail({ definition: { status: 'archived', revision: 5, realizedRevision: 4 } }) : { updated: true }));
    expect((await call(stale.client, 'update_net_definition', { action: 'unarchive', sessionId: 'identity', netId: 'risk' })).data.status).toBe('draft');

    const open = await connect(() => detail({ builds: [{ buildId: 'b-9', attempt: { state: 'building' } }] }));
    const refused = await call(open.client, 'update_net_definition', { action: 'archive', sessionId: 'identity', netId: 'risk' });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ code: 'build-open', buildId: 'b-9' });
    expect(open.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('create from a template fills what the caller leaves out, records templateId and references', async () => {
    const TEMPLATES = {
      templates: [{
        id: 'intake-lane', name: 'Intake lane',
        template: {
          interactions: 'reads an inbox', acceptance: ['every item ends accepted or parked'],
          domain: 'fulfilment', tags: ['intake'], description: 'Accepts items',
        },
      }],
    };
    const { client, calls } = await connect((c) => (c.path.includes('/templates') ? TEMPLATES : { key: 'ops::orders' }));
    await call(client, 'update_net_definition', {
      action: 'create', sessionId: 'ops', name: 'Order intake', templateId: 'intake-lane',
      domain: 'orders', references: [{ kind: 'code', uri: 'src/orders/Intake.java', label: 'Intake' }],
    });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/explorer/m1/templates?modelId=m1' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/explorer/m1/definitions?modelId=m1');
    expect(post.body).toMatchObject({ name: 'Order intake', description: 'Accepts items', domain: 'orders', tags: ['intake'] });
    expect(post.body.definition).toMatchObject({
      interactions: 'reads an inbox', acceptance: ['every item ends accepted or parked'], templateId: 'intake-lane',
      references: [{ kind: 'code', uri: 'src/orders/Intake.java', label: 'Intake' }],
    });
  });

  it('create with an unknown template is refused', async () => {
    const { client, calls } = await connect(() => ({ templates: [] }));
    const out = await call(client, 'update_net_definition', {
      action: 'create', sessionId: 'ops', name: 'X', description: 'y', templateId: 'nope',
    });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe('not-found');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('the templates tool lists, saves and deletes through the template routes; the reader lists', async () => {
    const { client, calls } = await connect((c) => (c.method === 'GET' ? { templates: [{ id: 't1' }] } : { id: 't1', ok: true }));
    const listed = await call(client, 'net_definition_templates', { action: 'list' });
    expect(listed.data.templates).toEqual([{ id: 't1' }]);
    await call(client, 'net_definition_templates', {
      action: 'save', templateId: 't1', name: 'Lane', description: 'a lane', template: { interactions: 'x' }, by: 'alex',
    });
    await call(client, 'net_definition_templates', { action: 'delete', templateId: 't1' });
    const reader = await call(client, 'list_net_definition_templates');
    expect(reader.data.templates).toEqual([{ id: 't1' }]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /explorer/m1/templates?modelId=m1',
      'PUT /explorer/m1/templates/t1?modelId=m1',
      'DELETE /explorer/m1/templates/t1?modelId=m1',
      'GET /explorer/m1/templates?modelId=m1',
    ]);
    expect(calls[1].body).toEqual({ name: 'Lane', description: 'a lane', template: { interactions: 'x' }, updatedBy: 'alex' });
    const missing = await call(client, 'net_definition_templates', { action: 'save', name: 'no id' });
    expect(missing.data.code).toBe('missing-field');
  });

  it('readonly mode lists templates but cannot change them', async () => {
    const { client } = await connect(() => ({}), { mode: 'readonly' });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_net_definition_templates');
    expect(names).not.toContain('net_definition_templates');
  });

  it('list_net_definitions hides archived definitions unless asked', async () => {
    const withArchived = {
      ...CATALOGUE,
      definitions: [
        ...CATALOGUE.definitions,
        { ref: { sessionId: 'identity', netId: 'old' }, key: 'identity::old', status: 'archived', revision: 3 },
      ],
    };
    const { client } = await connect(() => withArchived);
    const active = await call(client, 'list_net_definitions');
    expect(active.data.definitions.map((d: any) => d.key)).not.toContain('identity::old');
    expect(active.data).toMatchObject({ total: 3, archivedHidden: 1 });
    const archived = await call(client, 'list_net_definitions', { status: 'archived' });
    expect(archived.data.definitions.map((d: any) => d.key)).toEqual(['identity::old']);
    const all = await call(client, 'list_net_definitions', { includeArchived: true });
    expect(all.data.definitions).toHaveLength(3);
  });

  it('get_net_definition returns references and templateId', async () => {
    const refs = [{ kind: 'trace', uri: 'transition_history:t-x', label: 'last run' }];
    const { client } = await connect(() => detail({ definition: { references: refs, templateId: 'intake-lane' } }));
    const out = await call(client, 'get_net_definition', { sessionId: 'identity', netId: 'risk' });
    expect(out.data.references).toEqual(refs);
    expect(out.data.templateId).toBe('intake-lane');
  });

  it('explore_model summary lists relations, marks missing targets, and narrows them with query', () => {
    expect(relationLines(REL_CATALOGUE)).toEqual([
      'product::overview explains identity::risk',
      'product::overview depends-on identity::login',
      'identity::risk references identity::gone (missing)',
    ]);
    const all = summarize(REL_CATALOGUE);
    expect(all.relations).toHaveLength(3);
    const narrowed = summarize({ ...REL_CATALOGUE, nets: [{ key: 'identity::login', title: 'Login' }, { key: 'product::overview' }] }, 'login');
    expect(narrowed.relations).toEqual(['product::overview depends-on identity::login']);
    expect(summarize({ modelId: 'old', nets: [] })).not.toHaveProperty('relations');
  });
});

describe('definition body', () => {
  it('drops identity and joined build state before a definition is written back', async () => {
    const { definitionBody } = await import('../src/tools/definitions.js');
    const body = definitionBody({ ref: {}, key: 's::n', status: 'realized', revision: 2, realizedRevision: 1,
      activeBuild: 'b-1', latestBuildId: 'b-1', latestBuildState: 'building', realizations: [{ sessionId: 's', netId: 'v' }] });
    expect(body).toEqual({ status: 'realized', revision: 2, realizedRevision: 1, realizations: [{ sessionId: 's', netId: 'v' }] });
  });
});

describe('net_levels', () => {
  it('lists levels and saves the whole ordered list with locks', async () => {
    const { client, calls } = await connect((c) => (c.method === 'GET'
      ? { levels: [{ id: 'product', name: 'Product', order: 0 }] }
      : { levels: c.body.levels }));
    const listed = await call(client, 'net_levels', { action: 'list' });
    expect(listed.data.levels).toEqual([{ id: 'product', name: 'Product', order: 0 }]);
    const saved = await call(client, 'net_levels', { action: 'save', levels: [
      { id: 'product', name: 'Product', locked: true, lockNote: 'audit' }, { id: 'service', name: 'Service' }] });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/explorer/m1/levels?modelId=m1');
    expect(put?.body.levels).toEqual([
      { id: 'product', name: 'Product', locked: true, lockNote: 'audit', order: 0 },
      { id: 'service', name: 'Service', order: 1 }]);
    expect(saved.data.levels).toHaveLength(2);
  });

  it('lists when no action is given (a reader needs no verb)', async () => {
    const { client, calls } = await connect(() => ({ levels: [{ id: 'service', name: 'Service', order: 0 }] }));
    const out = await call(client, 'net_levels', {});
    expect(out.isError).toBe(false);
    expect(out.data.levels).toEqual([{ id: 'service', name: 'Service', order: 0 }]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('refuses a save without the list', async () => {
    const { client } = await connect(() => ({}));
    const out = await call(client, 'net_levels', { action: 'save' });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe('missing-field');
  });
});

describe('definition resources', () => {
  it('reads definitions of an allowed model and refuses others; serves the protocol', async () => {
    const { client, calls } = await connect((c) => (c.path.includes('/protocol')
      ? { name: 'net-definition-build', states: ['queued'] }
      : { definitions: [{ key: 's::n', status: 'ready' }], levels: [] }));
    const listed: any = await client.listResourceTemplates();
    expect(listed.resourceTemplates.map((t: any) => t.uriTemplate)).toContain('agenticnets://definitions/{model}');
    const read: any = await client.readResource({ uri: 'agenticnets://definitions/m1' });
    expect(JSON.parse(read.contents[0].text).definitions).toEqual([{ key: 's::n', status: 'ready' }]);
    expect(calls.some((c) => c.path === '/explorer/m1/catalogue?modelId=m1')).toBe(true);
    await expect(client.readResource({ uri: 'agenticnets://definitions/other' })).rejects.toThrow();
    const protocol: any = await client.readResource({ uri: 'agenticnets://definitions-protocol' });
    expect(JSON.parse(protocol.contents[0].text).name).toBe('net-definition-build');
  });
});
