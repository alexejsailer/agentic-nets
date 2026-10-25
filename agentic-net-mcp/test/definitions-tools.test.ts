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
import { nextActions } from '../src/tools/definitions.js';

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
      subjectKind: 'net-definition', subjectKey: 'identity::risk', subjectRevision: 2, buildId: 'b-7',
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
