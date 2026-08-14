/**
 * Pins the external-fire fixes the 2026-08-14 lab verification produced:
 * 1. CLI_BINARY_MISSING lanes count as stranded everywhere MASTER_HAS_NO_PROVIDER does
 *    (list_external_fires, readiness) — and scheduler_status labels them with THEIR reason,
 *    not the provider's.
 * 2. The "has work" predicate is ready && servable !== false: a MASTER_OWNS_IT lane with
 *    bound tokens is not this session's work.
 * 3. complete_external_fire validates shapes client-side BEFORE the wire: success:false
 *    requires error; a successful completion requires response|emissions|summary.
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
    persistedModels: [], allowlistPath: '/tmp/agenticnets-complete-test.json',
    persistAllowlist: false, nativeTools: 'curated',
  };
}

const PROVIDER_STRANDED = {
  transitionId: 't-review', kind: 'agent', status: 'running', ready: true,
  servable: true, servableReason: 'MASTER_HAS_NO_PROVIDER',
};
/** A bash-backed lane whose claude binary master cannot reach: just as silent, different fix. */
const CLI_STRANDED = {
  transitionId: 't-persona', kind: 'agent', status: 'running', ready: true,
  executionBackend: 'headless-cli:claude', requiresServerLlmProvider: false,
  servable: true, servableReason: 'CLI_BINARY_MISSING',
};
/** ready (tokens bound) but master fires it itself — NOT this session's work. */
const MASTER_OWNED = {
  transitionId: 't-owned', kind: 'llm', status: 'running', ready: true,
  servable: false, servableReason: 'MASTER_OWNS_IT',
};

function connect(opts: { providerDisabled?: boolean; rows?: any[]; scheduled?: any[] } = {}) {
  const calls: Array<{ method: string; path: string; body?: any; query?: Record<string, string> }> = [];
  const disabled = opts.providerDisabled !== false;
  const rows = opts.rows ?? [PROVIDER_STRANDED, CLI_STRANDED];
  const ctx = new AppContext(config());
  (ctx.client as any).masterApi = async (
    method: string, path: string, body?: any, query?: Record<string, string>,
  ) => {
    calls.push({ method, path, body, query });
    if (path === '/transitions/external/ready') {
      return {
        modelId: 'm1',
        provider: { name: disabled ? 'disabled' : 'ollama', canFireAiLanes: !disabled },
        transitions: rows,
      };
    }
    if (path === '/llm/health') {
      return {
        status: disabled ? 'DISABLED' : 'READY',
        headlessCliBinaries: { claude: false, codex: true },
      };
    }
    if (path === '/vault/health') return { status: 'DISABLED' };
    if (path === '/executors') return { executors: [] };
    if (path === '/models/m1/execution/status') return { transitions: opts.scheduled ?? [] };
    if (path === '/event-line/m1') return { events: [] };
    if (path.endsWith('/external/complete')) {
      return { accepted: true, fireId: body?.fireId, success: body?.success !== false };
    }
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
  return { body: JSON.parse(result.content[0].text), isError: Boolean(result.isError) };
}

describe('CLI_BINARY_MISSING is stranded too', () => {
  it('list_external_fires strands both reasons and names each fix', async () => {
    const { body } = (await call(await connectClient(), 'list_external_fires', { includeAll: true }));
    expect(body.stranded).toEqual(['t-review', 't-persona']);
    expect(body.next).toMatch(/no LLM provider/);
    expect(body.next).toMatch(/missing CLI binary/);
  });

  it('readiness counts a CLI-stranded lane in strandedTransitions', async () => {
    const { body } = await call(await connectClient(), 'readiness');
    expect(body.externalFires.stranded).toBe(2);
    expect(body.externalFires.strandedTransitions.map((t: any) => t.transitionId))
      .toEqual(['t-review', 't-persona']);
  });

  it('scheduler_status labels a CLI-stranded scheduled lane with ITS reason', async () => {
    const { client } = await connect({
      scheduled: [
        {
          transitionId: 't-persona', kind: 'agent', status: 'running',
          executionBackend: 'headless-cli:claude', requiresServerLlmProvider: false,
          schedule: { type: 'cron', cron: '0 0 3 * * *', armedAtMillis: 1 },
        },
        {
          transitionId: 't-nightly', kind: 'llm', status: 'running',
          schedule: { type: 'cron', cron: '0 0 4 * * *', armedAtMillis: 1 },
        },
      ],
    });
    const { body } = await call(client, 'scheduler_status');
    const reasons = Object.fromEntries(
      body.headline.externalScheduled.map((t: any) => [t.transitionId, t.reason]),
    );
    // the mislabel this pins: a CLI-stranded lane blamed on the provider sends the operator
    // to "configure a provider" when the fix is "install/repair the binary"
    expect(reasons['t-persona']).toBe('CLI_BINARY_MISSING');
    expect(reasons['t-nightly']).toBe('MASTER_HAS_NO_PROVIDER');
  });

  async function connectClient() {
    const { client } = await connect();
    return client;
  }
});

describe('the has-work predicate is ready && servable', () => {
  it('a ready MASTER_OWNS_IT lane produces no "have work" message', async () => {
    const { client } = await connect({ providerDisabled: false, rows: [MASTER_OWNED] });
    const { body } = await call(client, 'list_external_fires', { includeAll: true });
    expect(body.next).toBeUndefined();
    expect(body.stranded).toBeUndefined();
  });
});

describe('complete_external_fire client-side validation', () => {
  it('success:false without error is refused before the wire', async () => {
    const { client, calls } = await connect();
    const { body, isError } = await call(client, 'complete_external_fire', {
      transitionId: 't-review', fireId: 'f-1', success: false,
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toMatch(/requires 'error'/);
    expect(calls.some((c) => c.path.endsWith('/external/complete'))).toBe(false);
  });

  it('a successful completion without any result is refused before the wire', async () => {
    const { client, calls } = await connect();
    const { body, isError } = await call(client, 'complete_external_fire', {
      transitionId: 't-review', fireId: 'f-1',
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toMatch(/response.*emissions|emissions.*response/);
    expect(calls.some((c) => c.path.endsWith('/external/complete'))).toBe(false);
  });

  it('a well-shaped completion reaches master', async () => {
    const { client, calls } = await connect();
    const { body, isError } = await call(client, 'complete_external_fire', {
      transitionId: 't-review', fireId: 'f-1', response: '{"verdict":"ok"}',
    });
    expect(isError).toBe(false);
    expect(body.accepted).toBe(true);
    const wire = calls.find((c) => c.path.endsWith('/external/complete'));
    expect(wire?.body?.fireId).toBe('f-1');
  });

  it('a well-shaped failure (error present) reaches master', async () => {
    const { client, calls } = await connect();
    const { isError } = await call(client, 'complete_external_fire', {
      transitionId: 't-review', fireId: 'f-1', success: false, error: 'client model unavailable',
    });
    expect(isError).toBe(false);
    expect(calls.some((c) => c.path.endsWith('/external/complete'))).toBe(true);
  });
});
