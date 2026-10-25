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
import { refineWorklist } from '../src/tools/refine.js';

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

describe('review_model', () => {
  const REVIEW = {
    modelId: 'm1',
    curation: { installed: true, version: '1.0.0' },
    interview: { installed: true, version: '1.4.0', supportsSubjects: true },
    subjects: [
      { subjectKind: 'net', subjectKey: 'product::overview', state: 'confirmed', confirmed: { markId: 'c-1', by: 'the person', at: '2026-10-12T10:00:00Z', revision: 2, sourceHash: 'abcd' }, flags: [], resolvedFlags: 0, openQuestions: [] },
      { subjectKind: 'element', subjectKey: 'product::overview#t-auth', state: 'flagged', confirmed: null, flags: [{ markId: 'f-1', flag: 'level-below-changed', reason: 'identity::account-access changed', by: 'curate.py', status: 'open' }], resolvedFlags: 0, openQuestions: [] },
      { subjectKind: 'net', subjectKey: 'identity::risk-analysis', state: 'unconfirmed', confirmed: null, flags: [], resolvedFlags: 0, openQuestions: [{ promptId: 'q-1', question: 'Which risks count?' }] },
    ],
    counts: { subjects: 3, confirmed: 1, flagged: 1, openFlags: 1, openQuestions: 1, subjectsWithQuestions: 1 },
  };
  const LEVELLED = { ...CATALOGUE, nets: CATALOGUE.nets.map((n) => ({ ...n, layer: n.key.startsWith('product') ? 'product' : 'service' })) };

  async function review(args: Record<string, unknown> = {}) {
    const { client, calls } = await connect((path) => (path.includes('/curation') ? REVIEW : LEVELLED));
    const result: any = await client.callTool({ name: 'review_model', arguments: args });
    return { out: JSON.parse(result.content[0].text), calls };
  }

  it('lists every net with its state, rolls element marks up, and counts per level', async () => {
    const { out, calls } = await review();
    expect(calls.sort()).toEqual(['/explorer/m1/catalogue?modelId=m1', '/explorer/m1/curation?modelId=m1']);
    expect(out.total).toBe(3);
    const overview = out.nets.find((n: any) => n.key === 'product::overview');
    expect(overview.state).toBe('confirmed');
    expect(overview.confirmed.sourceHash).toBe('abcd');
    expect(overview.elements).toEqual([{ elementId: 't-auth', state: 'flagged', flags: [{ markId: 'f-1', flag: 'level-below-changed', reason: 'identity::account-access changed', by: 'curate.py' }], openQuestions: [] }]);
    expect(overview.openFlags).toBe(1);
    const risk = out.nets.find((n: any) => n.key === 'identity::risk-analysis');
    expect(risk.state).toBe('unconfirmed');
    expect(risk.openQuestionCount).toBe(1);
    expect(out.levels).toEqual({
      product: { nets: 1, confirmed: 1, flagged: 1, questions: 0, unconfirmed: 0 },
      service: { nets: 2, confirmed: 0, flagged: 0, questions: 1, unconfirmed: 2 },
    });
    expect(out.markWith.flag.input.flag).toMatch(/stale\|unclear/);
  });

  it('narrows to a level, a net, or what needs the person', async () => {
    expect((await review({ level: 'service' })).out.nets.map((n: any) => n.key)).toEqual(['identity::account-access', 'identity::risk-analysis']);
    expect((await review({ net: 'product::overview' })).out.nets.map((n: any) => n.key)).toEqual(['product::overview']);
    expect((await review({ needs: 'flagged' })).out.nets.map((n: any) => n.key)).toEqual(['product::overview']);
    expect((await review({ needs: 'questions' })).out.nets.map((n: any) => n.key)).toEqual(['identity::risk-analysis']);
    expect((await review({ needs: 'unconfirmed' })).out.nets.map((n: any) => n.key)).toEqual(['identity::account-access', 'identity::risk-analysis']);
    expect((await review({ needs: 'any' })).out.matched).toBe(3);
  });

  it('a master without the curation route answers available:false', async () => {
    const { client } = await connect((path) => {
      if (!path.includes('/curation')) return CATALOGUE;
      const err: any = new Error('Gateway 404');
      err.status = 404;
      throw err;
    });
    const result: any = await client.callTool({ name: 'review_model', arguments: {} });
    const out = JSON.parse(result.content[0].text);
    expect(out.available).toBe(false);
  });
});

describe('refine_model and curate_model', () => {
  const LEVELLED = {
    ...CATALOGUE,
    nets: [
      { ...CATALOGUE.nets[0], layer: 'product', transitionIds: ['t-auth', 't-risk', 't-pay'], parent: null, tags: [] },
      { ...CATALOGUE.nets[1], layer: 'service', transitionIds: ['t-login'], parent: { ref: { sessionId: 'product', netId: 'overview' }, elementId: 't-auth', elementType: 'transition' }, tags: [] },
      { ...CATALOGUE.nets[2], layer: 'service', transitionIds: [], parent: null, tags: [] },
      { key: 'application-interview::net', title: 'Interview', layer: 'work', transitionIds: ['t-x'], parent: null, tags: ['app'] },
    ],
    relations: [],
  };
  const REVIEW = {
    modelId: 'm1', curation: { installed: true }, interview: { installed: true, supportsSubjects: true },
    subjects: [
      { subjectKey: 'product::overview', state: 'confirmed', confirmed: { by: 'the person' }, flags: [], openQuestions: [] },
      { subjectKey: 'identity::account-access#t-login', state: 'flagged', confirmed: null, flags: [{ markId: 'f-1', flag: 'stale', reason: 'sources changed', by: 'curate.py' }], openQuestions: [] },
      { subjectKey: 'identity::risk-analysis', state: 'unconfirmed', confirmed: null, flags: [], openQuestions: [{ promptId: 'q-1', question: 'Which risks?' }] },
    ],
    counts: {},
  };

  it('lists the gaps top-down and bottom-up with ready-made questions, most pressing first', () => {
    const out = refineWorklist(LEVELLED, REVIEW);
    expect(out.nets).toBe(3); // the application net is not the model
    const kinds = out.items.map((i: any) => `${i.kind} ${i.subjectKey}`);
    expect(kinds).toEqual([
      'open-flag identity::account-access#t-login',
      'refinement-not-ok product::overview#t-risk',
      'open-question identity::risk-analysis',
      'definition-open identity::risk-analysis',
      'unrefined-transition identity::account-access#t-login',
      'unrefined-transition product::overview#t-pay',
      'no-parent identity::risk-analysis',
      'unconfirmed identity::account-access',
      'unconfirmed identity::risk-analysis',
    ]);
    const pay = out.items.find((i: any) => i.subjectKey === 'product::overview#t-pay');
    expect(pay.ask.subjectKey).toBe('product::overview#t-pay');
    expect(pay.ask.options).toHaveLength(3);
    expect(out.counts['unrefined-transition']).toBe(2);
    // The top level never gets a no-parent item; a net with a parent neither.
    expect(kinds.filter((k: string) => k.startsWith('no-parent'))).toEqual(['no-parent identity::risk-analysis']);
  });

  it('narrows by direction, level, net and count', () => {
    expect(refineWorklist(LEVELLED, REVIEW, { direction: 'up' }).items.map((i: any) => i.kind))
      .toEqual(['open-flag', 'open-question', 'no-parent', 'unconfirmed', 'unconfirmed']);
    expect(refineWorklist(LEVELLED, REVIEW, { level: 'product' }).items.map((i: any) => i.kind))
      .toEqual(['refinement-not-ok', 'unrefined-transition']);
    expect(refineWorklist(LEVELLED, REVIEW, { net: 'identity::risk-analysis', count: 2 }).returned).toBe(2);
  });

  it('curate_model ask derives the subject kind and answer can confirm in the same call', async () => {
    const posted: Array<{ path: string; body: any }> = [];
    const ctx = new AppContext(config());
    (ctx.client as any).masterApi = async (method: string, path: string, body?: any) => {
      if (method === 'POST') { posted.push({ path, body }); return { success: true }; }
      return path.includes('/curation') ? REVIEW : LEVELLED;
    };
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const asked: any = JSON.parse(((await client.callTool({ name: 'curate_model', arguments: {
      action: 'ask', subjectKey: 'product::overview#t-pay', question: 'What happens in t-pay?', options: ['a', 'b'], subjectRevision: 2, reasoning: 'because the fee is settled elsewhere', evidence: ['rules.md line 4: fee = 0'],
    } })) as any).content[0].text);
    expect(asked.promptId).toMatch(/^q-product-overview-t-pay-\d{14}$/);
    expect(posted[0].path).toBe('/applications/m1/interview/actions/ask');
    expect(posted[0].body).toMatchObject({ subjectKind: 'net-element', subjectKey: 'product::overview#t-pay', subjectRevision: 2, options: ['a', 'b'], source: 'question-round' });
    expect(posted[0].body).toMatchObject({ reasoning: 'because the fee is settled elsewhere', evidence: ['rules.md line 4: fee = 0'] });
    const answered: any = JSON.parse(((await client.callTool({ name: 'curate_model', arguments: {
      action: 'answer', promptId: asked.promptId, selected: ['a'], then: 'confirm', subjectKey: 'product::overview#t-pay', notes: 'because', respondedBy: 'the person',
    } })) as any).content[0].text);
    expect(posted[1].path).toBe('/applications/m1/interview/actions/respond');
    expect(posted[1].body).toMatchObject({ promptId: asked.promptId, intent: 'answer', selected: ['a'], respondedBy: 'the person' });
    expect(posted[2].path).toBe('/applications/m1/curation/actions/confirm');
    expect(posted[2].body).toMatchObject({ subjectKind: 'element', subjectKey: 'product::overview#t-pay', by: 'the person', note: 'because' });
    expect(answered.confirmed.markId).toMatch(/^confirm-product-overview-t-pay-/);
    const flagged: any = await client.callTool({ name: 'curate_model', arguments: { action: 'flag', subjectKey: 'rules', flag: 'too-coarse', reason: 'one net for twelve rules', by: 'me' } });
    expect(JSON.parse(flagged.content[0].text).markId).toMatch(/^flag-too-coarse-rules-/);
    expect(posted[3].body).toMatchObject({ subjectKind: 'level', subjectKey: 'rules', flag: 'too-coarse' });
    const missing: any = await client.callTool({ name: 'curate_model', arguments: { action: 'resolve', markId: 'f-1' } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/needs how/);
  });
});

describe('refine_model on a master that serves the worklist', () => {
  it('returns the served list untouched, plus the next-step hint, without reading the catalogue', async () => {
    const served = { modelId: 'm1', direction: 'both', mode: 'review', counts: { unconfirmed: 1 }, levels: { product: 1 }, total: 1, returned: 1, deferred: 2,
      items: [{ kind: 'unconfirmed', direction: 'review', subjectKey: 'product::overview', netKey: 'product::overview', title: 'Overview', level: 'product', detail: 'x', ask: { subjectKey: 'product::overview', question: 'ok?' } }] };
    const master: any = (path: string) => (path.includes('/worklist') ? served : CATALOGUE);
    master.servesWorklist = true;
    const { client, calls } = await connect(master);
    const result: any = await client.callTool({ name: 'refine_model', arguments: { mode: 'review', count: 5 } });
    const out = JSON.parse(result.content[0].text);
    expect(calls).toEqual(['/explorer/m1/worklist?modelId=m1&direction=both&mode=review&count=5']);
    expect(out.items).toEqual(served.items);
    expect(out.deferred).toBe(2);
    expect(out.next).toMatch(/curate_model/);
  });
});

describe('focus_digest and the pass record', () => {
  it('focus_digest returns the served digest plus the next-step hint; curate_model pass posts the record', async () => {
    const served = { modelId: 'm1', since: '2026-10-13T11:30:00Z', until: '2026-10-13T16:00:00Z', lastPass: { passId: 'pass-1' }, passes: 1,
      counts: { answers: 1, confirmations: 0, flags: 0, resolutions: 0, deferrals: 0, openQuestions: 1 },
      levels: [{ level: 'product', subjects: [{ subjectKey: 'product::overview', answers: [{ promptId: 'q-1', text: 'no' }] }] }] };
    const posted: Array<{ path: string; body: any }> = [];
    const ctx = new AppContext(config());
    const calls: string[] = [];
    (ctx.client as any).masterApi = async (method: string, path: string, body?: any) => {
      calls.push(path);
      if (method === 'POST') { posted.push({ path, body }); return { ok: true }; }
      if (path.includes('/digest')) return served;
      return CATALOGUE;
    };
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const digest: any = await client.callTool({ name: 'focus_digest', arguments: { level: 'product' } });
    const out = JSON.parse(digest.content[0].text);
    expect(calls).toEqual(['/explorer/m1/digest?modelId=m1&level=product']);
    expect(out.levels[0].subjects[0].answers[0].text).toBe('no');
    expect(out.until).toBe('2026-10-13T16:00:00Z');
    expect(out.next).toMatch(/refinement-pass/);

    const pass: any = await client.callTool({ name: 'curate_model', arguments: {
      action: 'pass', consumedUntil: out.until, scope: 'product', summary: 'revised the overview', answers: 1,
      changes: ['product::overview revised (rev 3)'], questions: ['q-2'], by: 'claude', passId: 'pass-2' } });
    const rec = JSON.parse(pass.content[0].text);
    expect(rec.passId).toBe('pass-2');
    expect(posted).toHaveLength(1);
    expect(posted[0].path).toBe('/applications/m1/curation/actions/pass');
    expect(posted[0].body).toMatchObject({ passId: 'pass-2', kind: 'refinement-pass', consumedUntil: '2026-10-13T16:00:00Z', scope: 'product', answers: 1, questions: ['q-2'], by: 'claude' });
    expect(typeof posted[0].body.startedAt).toBe('string');

    const missing: any = await client.callTool({ name: 'curate_model', arguments: { action: 'pass' } });
    expect(missing.isError).toBe(true);
  });

  it('focus_digest on an older master says so instead of failing', async () => {
    const { client } = await connect((path) => { if (path.includes('/digest')) { const e: any = new Error('nf'); e.status = 404; throw e; } return CATALOGUE; });
    const result: any = await client.callTool({ name: 'focus_digest', arguments: {} });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ available: false, model: 'm1' });
  });
});

describe('audience, own questions and the ground', () => {
  it('refine_model passes the audience through and ground_model returns the served chains with the next step', async () => {
    const served = { modelId: 'm1', direction: 'both', mode: 'all', for: 'person', counts: {}, audiences: { person: 1, model: 5 }, levels: {}, total: 1, returned: 1, deferred: 0, items: [] };
    const ground = { modelId: 'm1', level: 'service', counts: { chains: 1, nodes: 2 }, chains: [{ bottom: 'identity::account-access', nodes: [{ key: 'identity::account-access' }, { key: 'product::overview' }] }] };
    const master: any = (path: string) => (path.includes('/worklist') ? served : path.includes('/ground') ? ground : CATALOGUE);
    master.servesWorklist = true;
    const { client, calls } = await connect(master);
    const wl: any = JSON.parse(((await client.callTool({ name: 'refine_model', arguments: { for: 'person' } })) as any).content[0].text);
    expect(calls[0]).toBe('/explorer/m1/worklist?modelId=m1&direction=both&for=person');
    expect(wl.audiences).toEqual({ person: 1, model: 5 });
    const g: any = JSON.parse(((await client.callTool({ name: 'ground_model', arguments: { level: 'service' } })) as any).content[0].text);
    expect(calls[1]).toBe('/explorer/m1/ground?modelId=m1&level=service');
    expect(g.chains[0].nodes.map((n: any) => n.key)).toEqual(['identity::account-access', 'product::overview']);
    expect(g.next).toMatch(/ground-model/);
  });

  it('curate_model raise posts an Interview request with its subject; reshape posts a revise response', async () => {
    const posted: Array<{ path: string; body: any }> = [];
    const ctx = new AppContext(config());
    (ctx.client as any).masterApi = async (method: string, path: string, body?: any) => {
      if (method === 'POST') { posted.push({ path, body }); return { ok: true }; }
      return CATALOGUE;
    };
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raised: any = JSON.parse(((await client.callTool({ name: 'curate_model', arguments: { action: 'raise', subjectKey: 'product::overview', question: 'Why no refunds?', by: 'the person' } })) as any).content[0].text);
    expect(posted[0].path).toBe('/applications/m1/interview/actions/raise');
    expect(posted[0].body).toMatchObject({ question: 'Why no refunds?', raisedBy: 'the person', subjectKind: 'net-definition', subjectKey: 'product::overview' });
    expect(String(raised.requestId)).toMatch(/^r-product-overview-/);
    const reshaped: any = JSON.parse(((await client.callTool({ name: 'curate_model', arguments: { action: 'reshape', promptId: 'q-1', revisedQuestion: 'Which refunds are allowed?' } })) as any).content[0].text);
    expect(posted[1].path).toBe('/applications/m1/interview/actions/respond');
    expect(posted[1].body).toMatchObject({ promptId: 'q-1', intent: 'revise', revisedQuestion: 'Which refunds are allowed?' });
    expect(reshaped.next).toMatch(/supersedes/);
    const missing: any = await client.callTool({ name: 'curate_model', arguments: { action: 'reshape', promptId: 'q-1' } });
    expect(missing.isError).toBe(true);
  });
});

