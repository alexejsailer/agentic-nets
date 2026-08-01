/**
 * Protocol-hardening invariants (see protocol-hardening.md): annotations
 * mirror mutability, misconception params bounce at the boundary, truncation
 * is loud and structural, and the readiness tool walks the whole chain.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';
import { validateKindArgs, validateScheduleArgs } from '../src/tools/nets.js';
import { clampValues, dedupeTokenPayload, evaluateLlmHealth } from '../src/tools/observe.js';

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

describe('tool annotations (trap #2: risk visible before calling)', () => {
  it('readOnlyHint mirrors mutability across curated and native layers; deletes carry destructiveHint', async () => {
    const client = await connectedClient(makeConfig());
    const { tools } = await client.listTools();
    const ann = (name: string) => (tools.find((t) => t.name === name) as any)?.annotations;
    // Curated reads/writes.
    expect(ann('query_tokens')?.readOnlyHint).toBe(true);
    expect(ann('readiness')?.readOnlyHint).toBe(true);
    expect(ann('memory_write')?.readOnlyHint).toBe(false);
    expect(ann('memory_write')?.destructiveHint).toBe(false);
    expect(ann('delete_transition_credentials')?.destructiveHint).toBe(true);
    // Native layer: no longer blanket-mutating — reads are annotated as reads.
    expect(ann('GET_TRANSITION')?.readOnlyHint).toBe(true);
    expect(ann('QUERY_TOKENS')?.readOnlyHint).toBe(true);
    expect(ann('SET_INSCRIPTION')?.readOnlyHint).toBe(false);
    expect(ann('DELETE_NET')?.readOnlyHint).toBe(false);
    expect(ann('DELETE_NET')?.destructiveHint).toBe(true);
    // TOOLNET_HEALTH can fire a live smoke (active=true) — must NOT read as read-only.
    expect(ann('TOOLNET_HEALTH')?.readOnlyHint).toBe(false);
  });
});

describe('MCP-first LLM readiness', () => {
  it('treats an intentionally disabled server model as an external-MCP capability', () => {
    const evaluated = evaluateLlmHealth({
      status: 'DISABLED',
      provider: 'disabled',
      externalMcpExecution: true,
    });

    expect(evaluated.problem).toBeUndefined();
    expect(evaluated.report.capability).toBe('external-mcp');
    expect(evaluated.report.note).toMatch(/llm\/agent lanes default to external/i);
  });

  it('still reports a genuinely broken server provider as a readiness problem', () => {
    const evaluated = evaluateLlmHealth({ status: 'UNREACHABLE', provider: 'ollama' });

    expect(evaluated.problem).toMatch(/master-run llm\/agent fire fails/i);
    expect(evaluated.report.warning).toMatch(/master-run llm\/agent transitions will fail/i);
  });
});

describe('validateKindArgs (trap #4: misconceptions bounce, never vanish)', () => {
  it('accepts kind-appropriate args', () => {
    expect(() => validateKindArgs('http', { netId: 'n', transitionId: 't', kind: 'http', inputPlace: 'a', outputPlace: 'b', url: 'https://x', headers: { A: 'b' }, errorPlace: 'p-err' })).not.toThrow();
    expect(() => validateKindArgs('llm', { kind: 'llm', prompt: 'p', tier: 'low', llmModel: 'm' })).not.toThrow();
    expect(() => validateKindArgs('agent', { kind: 'agent', role: 'rwxhl---t', tier: 'high', maxIterations: 5 })).not.toThrow();
  });

  it('bounces params that the kind would silently ignore, naming where they belong', () => {
    expect(() => validateKindArgs('map', { kind: 'map', url: 'https://x' })).toThrow(/url \(applies to kind http\)/);
    expect(() => validateKindArgs('http', { kind: 'http', template: { a: 1 } })).toThrow(/template \(applies to kind map\)/);
    expect(() => validateKindArgs('command', { kind: 'command', prompt: 'p' })).toThrow(/prompt \(applies to kind llm\/agent\)/);
    expect(() => validateKindArgs('map', { kind: 'map', tier: 'low' })).toThrow(/tier/);
    // Links never fire — a schedule on a link is a misconception, not a default.
    expect(() => validateKindArgs('link', { kind: 'link', scheduleCron: '0 0 8 * * *' })).toThrow(/scheduleCron/);
  });

  it('states that nothing was created (bounce happens before any write)', () => {
    expect(() => validateKindArgs('map', { kind: 'map', url: 'x' })).toThrow(/nothing was created/i);
  });
});

describe('clampValues (trap #3: truncate loudly, at structural boundaries)', () => {
  it('cuts long strings with an inline marker and sets the flag', () => {
    const state = { truncated: false };
    const out = clampValues({ a: 'x'.repeat(600), b: 'short' }, 500, state);
    expect(state.truncated).toBe(true);
    expect(out.a).toMatch(/\.\.\.\[truncated, 600 chars total\]$/);
    expect(out.b).toBe('short');
  });

  it('recurses into arrays and nested objects', () => {
    const state = { truncated: false };
    const out = clampValues([{ deep: { v: 'y'.repeat(20) } }], 10, state);
    expect(state.truncated).toBe(true);
    expect(out[0].deep.v).toContain('...[truncated');
  });

  it('max <= 0 disables clamping entirely (explicit full-payload opt-in)', () => {
    const state = { truncated: false };
    const long = 'z'.repeat(10_000);
    expect(clampValues({ a: long }, 0, state).a).toBe(long);
    expect(state.truncated).toBe(false);
  });

  it('never produces invalid JSON — output always re-serializes', () => {
    const state = { truncated: false };
    const original = '{"nested":"' + 'q'.repeat(999) + '"}';
    const out = clampValues({ a: original }, 100, state);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(out.a).toEqual({
      __truncated__: {
        bytes: Buffer.byteLength(original, 'utf8'),
        preview: original.slice(0, 120),
      },
    });
  });
});

describe('onEmpty is accepted where it applies and bounced where it does not', () => {
  const base = { netId: 'n', transitionId: 't', kind: 'map', inputPlace: 'a', outputPlace: 'b', template: { x: 1 } };

  // Regression: onEmpty was added to the tool schema but not to the applicable-param allowlist,
  // so every explicit onEmpty:"skip" was rejected outright while the default path worked. Caught
  // only by driving the real server — the shape unit tests never exercised the guard.
  it('accepts onEmpty on every firing kind when a schedule is present', () => {
    const wiring = { netId: 'n', transitionId: 't', inputPlace: 'a', outputPlace: 'b' };
    for (const kind of ['map', 'llm', 'http', 'command', 'agent']) {
      expect(() =>
        validateKindArgs(kind, { ...wiring, kind, intervalMs: 60_000, onEmpty: 'skip' }),
      ).not.toThrow();
    }
  });

  it('still bounces onEmpty on link, which never fires', () => {
    expect(() => validateKindArgs('link', { netId: 'n', transitionId: 't', kind: 'link', inputPlace: 'a', outputPlace: 'b', onEmpty: 'skip' })).toThrow(/not applicable/);
  });

  it('bounces onEmpty without a schedule rather than ignoring it', () => {
    expect(() => validateScheduleArgs({ ...base, onEmpty: 'skip' })).toThrow(/only applies to a SCHEDULED lane/);
  });

  it('allows a schedule without onEmpty, and onEmpty with either schedule form', () => {
    expect(() => validateScheduleArgs({ ...base, intervalMs: 60_000 })).not.toThrow();
    expect(() => validateScheduleArgs({ ...base, intervalMs: 60_000, onEmpty: 'fire' })).not.toThrow();
    expect(() => validateScheduleArgs({ ...base, scheduleCron: '0 0 8 * * *', onEmpty: 'skip' })).not.toThrow();
  });
});

describe('timezone and FOREACH batch argument validation', () => {
  it('accepts a cron timezone and rejects timezone without cron', () => {
    expect(() => validateScheduleArgs({ scheduleCron: '0 0 8 * * *', timezone: 'Europe/Berlin' })).not.toThrow();
    expect(() => validateScheduleArgs({ intervalMs: 1000, timezone: 'Europe/Berlin' })).toThrow(/timezone only applies/);
  });

  it('accepts batchSize only with FOREACH', () => {
    expect(() => validateScheduleArgs({ mode: 'FOREACH', batchSize: 5 })).not.toThrow();
    expect(() => validateScheduleArgs({ mode: 'SINGLE', batchSize: 5 })).toThrow(/FOREACH/);
  });
});

describe('dedupeTokenPayload (P3: the projection has to actually reduce the payload)', () => {
  const twin = () => ({
    results: [
      {
        data: { severity: 'CRITICAL', reason: 'SQL injection', extra: 'x'.repeat(200) },
        _meta: {
          id: 'u1',
          name: 't1',
          properties: { severity: 'CRITICAL', reason: 'SQL injection', extra: 'x'.repeat(200) },
        },
      },
    ],
  });

  it('drops _meta.properties when it merely repeats data', () => {
    const out: any = dedupeTokenPayload(twin());
    expect(out.results[0]._meta.properties).toBeUndefined();
    expect(out.results[0].data.severity).toBe('CRITICAL');
    expect(out._note).toMatch(/omitted/);
  });

  it('keeps the small, load-bearing part of _meta', () => {
    const out: any = dedupeTokenPayload(twin());
    expect(out.results[0]._meta.id).toBe('u1');
    expect(out.results[0]._meta.name).toBe('t1');
  });

  it('projects _meta.properties when it genuinely differs, keeping engine metadata', () => {
    const payload: any = {
      results: [
        {
          data: { a: 1 },
          _meta: { id: 'u1', properties: { a: 1, b: 2, _lock: '{"owner":"t-x"}', _parentPlace: 'p-in' } },
        },
      ],
    };
    const out: any = dedupeTokenPayload(payload, ['a']);
    const props = out.results[0]._meta.properties;
    expect(props.a).toBe(1);
    expect(props.b).toBeUndefined();
    // _lock must survive a projection — dropping it hides why a token cannot be bound.
    expect(props._lock).toBe('{"owner":"t-x"}');
    expect(props._parentPlace).toBe('p-in');
  });

  it('passes through anything that is not a token list', () => {
    expect(dedupeTokenPayload({ count: 0 })).toEqual({ count: 0 });
    expect(dedupeTokenPayload(null)).toBeNull();
    expect(dedupeTokenPayload('text')).toBe('text');
  });
});
