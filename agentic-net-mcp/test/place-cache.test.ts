/**
 * The known-places cache must not mask a place that is gone: a model deleted and created again under
 * the same id (or a place removed out of band) made every token write fail "not found" (e2e 2026-10-12).
 */
import { describe, expect, it } from 'vitest';
import { AppContext } from '../src/context.js';
import type { McpConfig } from '../src/config.js';
import { writeToken } from '../src/tools/memory.js';

function ctxWith(executor: (tool: string, args: any) => any) {
  const ctx = new AppContext({
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp', nodeHost: 'localhost:8080',
    transport: 'stdio', httpPort: 0, llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-place-cache-test.json', persistAllowlist: false,
    nativeTools: 'curated',
  } as McpConfig);
  const calls: string[] = [];
  (ctx as any).executorFor = () => ({ execute: async (tool: string, args: any) => { calls.push(tool); return executor(tool, args); } });
  (ctx as any).node = {
    getChildren: async (_m: string, path: string) => (path === 'root' ? [{ name: 'workspace', id: 'w' }] : [{ name: 'places', id: 'p' }]),
    executeEvents: async () => ({}),
  };
  return { ctx, calls };
}

describe('writeToken and the known-places cache', () => {
  it('a stale cache entry is forgotten, the place ensured again, and the write retried once', async () => {
    let created = false;
    const { ctx, calls } = ctxWith((tool) => {
      if (tool === 'CREATE_RUNTIME_PLACE') { created = true; return { success: true }; }
      if (tool === 'CREATE_TOKEN') return created ? { success: true } : { success: false, error: "Element 'p-x' not found at path 'root/workspace/places/p-x'" };
      return { success: true };
    });
    ctx.markPlaceKnown('m1', 'p-x'); // known from a model that has since been deleted
    const res = await writeToken(ctx, 'm1', 'p-x', { a: 1 });
    expect(res.success).toBe(true);
    expect(calls).toEqual(['CREATE_TOKEN', 'CREATE_RUNTIME_PLACE', 'CREATE_TOKEN']);
    expect(ctx.placeKnown('m1', 'p-x')).toBe(true);
  });

  it('any other failure is returned as it is, without a retry', async () => {
    const { ctx, calls } = ctxWith((tool) => (tool === 'CREATE_TOKEN' ? { success: false, error: 'node down' } : { success: true }));
    ctx.markPlaceKnown('m1', 'p-x');
    const res = await writeToken(ctx, 'm1', 'p-x', {});
    expect(res.success).toBe(false);
    expect(calls).toEqual(['CREATE_TOKEN']);
  });

  it('forgetting a model drops only that model\'s places', () => {
    const { ctx } = ctxWith(() => ({ success: true }));
    ctx.markPlaceKnown('m1', 'p-a'); ctx.markPlaceKnown('m1', 'p-b'); ctx.markPlaceKnown('m2', 'p-a');
    ctx.forgetModelPlaces('m1');
    expect([ctx.placeKnown('m1', 'p-a'), ctx.placeKnown('m1', 'p-b'), ctx.placeKnown('m2', 'p-a')]).toEqual([false, false, true]);
  });
});
