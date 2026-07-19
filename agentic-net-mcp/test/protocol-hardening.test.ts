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
import { validateKindArgs } from '../src/tools/nets.js';
import { clampValues } from '../src/tools/observe.js';

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
    const out = clampValues({ a: '{"nested":"' + 'q'.repeat(999) + '"}' }, 100, state);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });
});
