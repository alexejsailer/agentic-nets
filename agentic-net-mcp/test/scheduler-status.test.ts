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
    persistedModels: [], allowlistPath: '/tmp/agenticnets-status-test.json',
    persistAllowlist: false, nativeTools: 'curated',
  };
}

const statusResponse = {
  observedAt: '2026-08-01T12:00:00Z',
  transitions: [
    {
      transitionId: 't-stopped', kind: 'http', status: 'STOPPED', ready: true,
      eligibility: 'NOT_RUNNING',
      schedule: {
        type: 'cron', cron: '0 0 8 * * *', timezone: 'Europe/Berlin',
        valid: true, armedAtMillis: 1_754_000_000_000, lastFiredAtMillis: null,
        fireCount: 0, successCount: 0, nextFireAtMillis: 1_754_100_000_000,
        nextFireAtLocal: '2026-08-02 08:00 CEST',
      },
    },
    {
      transitionId: 't-invalid', kind: 'command', status: 'RUNNING', ready: true,
      eligibility: 'INVALID_SCHEDULE',
      schedule: {
        type: 'cron', cron: 'bad', valid: false, invalidReason: 'invalid cron',
      },
    },
  ],
};

async function clientWithStatus() {
  const ctx = new AppContext(config());
  (ctx.client as any).masterApi = async (_method: string, path: string) => {
    if (path === '/models/m1/execution/status') return statusResponse;
    if (path === '/llm/health') return { status: 'DISABLED' };
    if (path === '/vault/health') return { status: 'DISABLED' };
    if (path === '/executors') return { executors: [] };
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

describe('scheduler telemetry surface', () => {
  it('passes honest timestamps/timezone and headlines stopped + invalid schedules', async () => {
    const client = await clientWithStatus();
    const result: any = await client.callTool({ name: 'scheduler_status', arguments: {} });
    const body = JSON.parse(result.content[0].text);

    expect(body.headline.stoppedScheduled.map((lane: any) => lane.transitionId)).toEqual(['t-stopped']);
    expect(body.headline.invalidSchedules.map((lane: any) => lane.transitionId)).toEqual(['t-invalid']);
    expect(body.transitions[0]).toMatchObject({
      transitionId: 't-stopped', neverFired: true, lastFiredAt: null,
      fireCount: 0, successCount: 0, timezone: 'Europe/Berlin',
      nextFireAtLocal: '2026-08-02 08:00 CEST',
    });
    expect(body.fieldGuide.telemetry).toMatch(/literally never dispatched/);
  });

  it('readiness warns about stopped schedules without making the installation unready', async () => {
    const client = await clientWithStatus();
    const result: any = await client.callTool({ name: 'readiness', arguments: {} });
    const body = JSON.parse(result.content[0].text);

    expect(body.ready).toBe(true);
    expect(body.warnings.join(' ')).toMatch(/t-stopped/);
    expect(body.warnings.join(' ')).toMatch(/t-invalid/);
    expect(body.problems).toBeUndefined();
  });
});
