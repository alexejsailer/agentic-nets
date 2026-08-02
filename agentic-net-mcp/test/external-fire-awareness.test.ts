/**
 * Without a server-side provider, llm/agent lanes run ONLY while a client is connected —
 * and a schedule on one is armed but dispatched by nobody. Both facts are invisible in the
 * raw status (the lane looks like an active state, the cron looks armed), so the protocol
 * has to volunteer them. These tests pin that the surfaces actually say it.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import { buildInstructions } from '../src/instructions.js';
import type { McpConfig } from '../src/config.js';

function config(): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp',
    nodeHost: 'localhost:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-external-test.json',
    persistAllowlist: false, nativeTools: 'curated',
  };
}

/** A scheduled external lane (the trap) plus a normal running deterministic one. */
const statusResponse = {
  observedAt: '2026-08-02T12:00:00Z',
  transitions: [
    {
      transitionId: 't-nightly-digest', kind: 'llm', status: 'external', ready: true,
      schedule: { type: 'cron', cron: '0 0 3 * * *', valid: true, nextFireAtMillis: 1_754_100_000_000 },
    },
    {
      transitionId: 't-probe', kind: 'http', status: 'RUNNING', ready: true,
      schedule: { type: 'interval', intervalMs: 60_000, valid: true },
    },
    // Not marked external, plainly RUNNING, cron armed — and with no provider it will never
    // fire. Reads as perfectly healthy on every other surface.
    {
      transitionId: 't-nightly-review', kind: 'agent', status: 'RUNNING', ready: true,
      schedule: { type: 'cron', cron: '0 0 4 * * *', valid: true, nextFireAtMillis: 1_754_100_000_000 },
    },
  ],
};

const externalReady = {
  transitions: [
    { transitionId: 't-nightly-digest', kind: 'llm', status: 'external', ready: true, presetTokenCounts: { input: 2 } },
    { transitionId: 't-idle', kind: 'agent', status: 'external', ready: false, note: 'presets not ready' },
  ],
};

async function connect(opts: { externalEndpoint?: boolean } = {}) {
  const ctx = new AppContext(config());
  (ctx.client as any).masterApi = async (_method: string, path: string) => {
    if (path === '/models/m1/execution/status') return statusResponse;
    if (path === '/llm/health') return { status: 'DISABLED' };
    if (path === '/vault/health') return { status: 'DISABLED' };
    if (path === '/executors') return { executors: [] };
    if (path === '/transitions/external/ready') {
      if (opts.externalEndpoint === false) {
        const err: any = new Error('not found');
        err.name = 'GatewayError';
        err.status = 404;
        throw err;
      }
      return externalReady;
    }
    throw new Error(`unexpected master path ${path}`);
  };
  (ctx.client as any).nodeApi = async (_method: string, path: string) => {
    if (path === '/admin/models') return [{ modelId: 'm1', state: 'ACTIVE' }];
    if (path.includes('/tree/')) return [{ name: 'places' }];
    throw new Error(`unexpected node path ${path}`);
  };
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string) {
  const result: any = await client.callTool({ name, arguments: {} });
  return JSON.parse(result.content[0].text);
}

describe('external-fire awareness', () => {
  it('readiness counts the backlog waiting for this session and says who must run it', async () => {
    const body = await call(await connect(), 'readiness');

    // only the bound-and-waiting lane counts as work; the idle one still shows in the total
    expect(body.externalFires).toMatchObject({ external: 2, waiting: 1 });
    expect(body.externalFires.transitions).toEqual([{ transitionId: 't-nightly-digest', kind: 'llm' }]);
    expect(body.externalFires.note).toMatch(/does NOT run unattended/);

    const warnings = (body.warnings ?? []).join(' ');
    expect(warnings).toMatch(/t-nightly-digest/);
    expect(warnings).toMatch(/prepare_external_fire/);

    // a backlog is work to do, not a broken install
    expect(body.ready).toBe(true);
    expect(body.problems).toBeUndefined();
  });

  it('readiness names this session as the runtime when no provider is configured', async () => {
    const body = await call(await connect(), 'readiness');
    expect(body.llm.youAreTheRuntime).toMatch(/only while an MCP client is connected/);
    expect(body.llm.youAreTheRuntime).toMatch(/cannot be scheduled/);
  });

  it('scheduler_status flags a scheduled external lane as never firing unattended', async () => {
    const body = await call(await connect(), 'scheduler_status');

    const digest = body.transitions.find((t: any) => t.transitionId === 't-nightly-digest');
    expect(digest.willNotFireUnattended).toBe(true);
    expect(digest.unattendedHint).toMatch(/never fires it/);

    expect(body.headline.externalScheduled.map((t: any) => t.transitionId))
      .toEqual(['t-nightly-digest', 't-nightly-review']);
    expect(body.externalScheduledCount).toBe(2);
    expect(body.externalScheduledHint).toMatch(/only happens while a client is connected/);

    // the deterministic lane keeps its schedule and must NOT be flagged
    const probe = body.transitions.find((t: any) => t.transitionId === 't-probe');
    expect(probe.willNotFireUnattended).toBeUndefined();
  });

  it('flags a RUNNING AI lane too when master has no provider to run it with', async () => {
    const body = await call(await connect(), 'scheduler_status');

    const review = body.transitions.find((t: any) => t.transitionId === 't-nightly-review');
    expect(review.status).toBe('RUNNING');
    expect(review.willNotFireUnattended).toBe(true);
    expect(review.unattendedHint).toMatch(/master has no LLM provider/);
    // overdue advice ('restart it') would be wrong here: nothing was going to fire it
    expect(review.overdue).toBeUndefined();

    // the two reasons a schedule goes nowhere stay distinguishable
    expect(body.headline.externalScheduled).toEqual([
      expect.objectContaining({ transitionId: 't-nightly-digest', reason: 'MARKED_EXTERNAL' }),
      expect.objectContaining({ transitionId: 't-nightly-review', reason: 'MASTER_HAS_NO_PROVIDER' }),
    ]);
  });

  it('degrades silently against a master without the external-fire endpoint', async () => {
    const body = await call(await connect({ externalEndpoint: false }), 'readiness');
    expect(body.externalFires).toBeUndefined();
    expect(body.ready).toBe(true);
  });

  it('instructions tell the client to check the backlog and not to promise unattended AI lanes', () => {
    const text = buildInstructions(config());
    expect(text).toMatch(/externalFires\.waiting/);
    expect(text).toMatch(/OFFER to work them/);
    // the scheduling section must carry the exception, or clients keep promising overnight runs
    expect(text).toMatch(/schedulers SKIP `external` lanes/);
  });
});
