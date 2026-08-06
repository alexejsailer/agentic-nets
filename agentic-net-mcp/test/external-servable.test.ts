/**
 * With no LLM provider, master cannot run ANY llm/agent lane, whatever its status. The default
 * discovery view only shows lanes someone marked `external` by hand, so the ones that matter most
 * — running lanes going nowhere — are exactly the ones it hides. These tests pin the wider view,
 * the verdict passthrough, and the hint that makes it findable.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

function config(): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp',
    nodeHost: 'localhost:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-servable-test.json',
    persistAllowlist: false, nativeTools: 'curated',
  };
}

const MARKED = {
  transitionId: 't-digest', kind: 'llm', status: 'external', ready: true,
  servable: true, servableReason: 'MARKED_EXTERNAL',
};
/** The lane the narrow view hides: running, healthy-looking, and dispatched by nobody. */
const STRANDED = {
  transitionId: 't-review', kind: 'agent', status: 'running', ready: true,
  servable: true, servableReason: 'MASTER_HAS_NO_PROVIDER',
};
const IDLE = {
  transitionId: 't-triage', kind: 'llm', status: 'stopped', ready: false,
  servable: false, servableReason: 'NO_TOKENS_BOUND',
};

/** Records every master call so a test can assert what was NOT called. */
function connect(opts: { providerDisabled?: boolean; events?: any[] } = {}) {
  const calls: Array<{ path: string; query?: Record<string, string> }> = [];
  const disabled = opts.providerDisabled !== false;
  const ctx = new AppContext(config());
  (ctx.client as any).masterApi = async (
    _m: string, path: string, _b?: any, query?: Record<string, string>,
  ) => {
    calls.push({ path, query });
    if (path === '/transitions/external/ready') {
      const all = query?.includeAll === 'true';
      return {
        modelId: 'm1',
        includeAll: all,
        provider: { name: disabled ? 'disabled' : 'ollama', canFireAiLanes: !disabled },
        transitions: all ? [MARKED, STRANDED, IDLE] : [MARKED],
      };
    }
    if (path === '/llm/health') return { status: disabled ? 'DISABLED' : 'READY' };
    if (path === '/vault/health') return { status: 'DISABLED' };
    if (path === '/executors') return { executors: [] };
    if (path === '/models/m1/execution/status') return { transitions: [] };
    if (path.startsWith('/transitions/') && path.endsWith('/external')) return { external: true };
    if (path === '/event-line/m1') return { events: opts.events ?? [] };
    throw new Error(`unexpected master path ${path}`);
  };
  (ctx.client as any).nodeApi = async (_m: string, path: string) => {
    if (path === '/admin/models') return [{ modelId: 'm1', state: 'ACTIVE' }];
    if (path.includes('/tree/')) return [{ name: 'places' }];
    throw new Error(`unexpected node path ${path}`);
  };
  const server = createServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  return Promise.all([server.connect(st), client.connect(ct)]).then(() => ({ client, calls }));
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

describe('servable AI-lane roster', () => {
  it('includeAll surfaces the lanes the default view hides', async () => {
    const { client } = await connect();

    const narrow = await call(client, 'list_external_fires');
    expect(narrow.transitions.map((t: any) => t.transitionId)).toEqual(['t-digest']);

    const wide = await call(client, 'list_external_fires', { includeAll: true });
    expect(wide.transitions.map((t: any) => t.transitionId))
      .toEqual(['t-digest', 't-review', 't-triage']);
    expect(wide.stranded).toEqual(['t-review']);
    expect(wide.servableCount).toBe(2);
    expect(wide.next).toMatch(/stranded/);
    expect(wide.next).toMatch(/t-review/);
  });

  it('points the client at the wider view when master has no provider', async () => {
    const { client } = await connect();
    const narrow = await call(client, 'list_external_fires');
    // without this the wider view is undiscoverable: the default list is the one that hides it
    expect(narrow.hint).toMatch(/includeAll:true/);
  });

  it('stays quiet about includeAll when master can run its own AI lanes', async () => {
    const { client } = await connect({ providerDisabled: false });
    const narrow = await call(client, 'list_external_fires');
    expect(narrow.hint).toBeUndefined();
    expect(narrow.stranded).toBeUndefined();
  });

  it('readiness counts stranded lanes and only pays for the sweep when the provider is down', async () => {
    const { client, calls } = await connect();
    const body = await call(client, 'readiness');

    expect(body.externalFires.stranded).toBe(1);
    expect(body.externalFires.strandedTransitions).toEqual([
      { transitionId: 't-review', kind: 'agent', status: 'running' },
    ]);
    expect((body.warnings ?? []).join(' ')).toMatch(/t-review/);
    expect(body.ready).toBe(true);

    const roster = calls.find((c) => c.path === '/transitions/external/ready');
    expect(roster?.query?.includeAll).toBe('true');
  });

  it('readiness refuses to call an unusable provider READY on health alone', async () => {
    // The staging shape this pins: /llm/health says READY (endpoint reachable, model listed)
    // while every inference is rejected on billing — 380 consecutive failures over a week,
    // all green on every diagnostic. Health is reachability; usability is the event line.
    const aiFail = (seq: number, tid: string, kind: string) => ({
      seq, category: 'transition', type: 'fire', status: 'error',
      attributes: { transitionId: tid, kind },
    });
    const { client } = await connect({
      providerDisabled: false,
      events: [
        aiFail(9, 't-a', 'llm'), aiFail(8, 't-a', 'llm'), aiFail(7, 't-b', 'agent'),
        { seq: 6, category: 'agent-step', status: 'error',
          details: { error: 'Ollama API error: this model uses extra usage only' } },
      ],
    });
    const body = await call(client, 'readiness');

    expect(body.llm.usable).toBe(false);
    expect(body.llm.warning).toMatch(/ALL failed/);
    expect(body.capabilities.llmLanes).toBe(false);
    expect(body.ready).toBe(false);
    expect((body.problems ?? []).join(' ')).toMatch(/extra usage only/);
  });

  it('readiness keeps a provider READY when recent AI fires actually succeed', async () => {
    const { client } = await connect({
      providerDisabled: false,
      events: [
        { seq: 3, category: 'transition', type: 'fire', status: 'error', attributes: { transitionId: 't-a', kind: 'llm' } },
        { seq: 2, category: 'transition', type: 'fire', status: 'success', attributes: { transitionId: 't-a', kind: 'llm' } },
        { seq: 1, category: 'transition', type: 'fire', status: 'error', attributes: { transitionId: 't-b', kind: 'agent' } },
      ],
    });
    const body = await call(client, 'readiness');

    expect(body.llm.usable).toBeUndefined();
    expect(body.capabilities.llmLanes).toBe(true);
  });

  it('readiness skips the expensive roster sweep on a healthy master', async () => {
    const { client, calls } = await connect({ providerDisabled: false });
    await call(client, 'readiness');

    const roster = calls.find((c) => c.path === '/transitions/external/ready');
    expect(roster?.query?.includeAll).toBeUndefined();
  });

  it('set_external all:true resolves lanes server-side instead of sweeping runtime transitions', async () => {
    const { client, calls } = await connect();
    await call(client, 'set_external', { external: true, all: true });

    // the old implementation re-derived "is this an AI lane" client-side from /runtime/transitions
    expect(calls.some((c) => c.path === '/runtime/transitions')).toBe(false);
    const roster = calls.find((c) => c.path === '/transitions/external/ready');
    expect(roster?.query?.includeAll).toBe('true');
  });
});
