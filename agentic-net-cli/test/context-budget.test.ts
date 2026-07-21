import { describe, expect, it } from 'vitest';
import { resolveContextCapsule } from '../src/agent/context.js';
import { CATALOG_CONSTANTS } from '../src/agent/capabilities.js';
import { FRAME, manifest, stubNodeApi } from './context-helpers.js';

/** Budget clamps come from the shared catalog constants and must actually bite. */
describe('resolveContextCapsule — budget', () => {
  const installed = (tokens: Record<string, unknown[]>, queries?: any[]) => stubNodeApi({
    queries,
    contexts: [{
      sessionId: 'ctx-1',
      manifest: manifest('notes', 'model', 'p-notes'),
      origin: { version: '1.0.0' },
    }],
    tokens,
  });

  it('cuts items and flags truncation when maxChars is exhausted', async () => {
    const bigItem = { data: 'x'.repeat(3000) };
    const nodeApi = installed({ 'p-notes': [bigItem, bigItem] });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true }],
      contextBudget: { maxChars: 2000 },
    });
    expect(capsule.budget.maxChars).toBe(CATALOG_CONSTANTS.contextBudget.minChars);
    expect(capsule.budget.truncated).toBe(true);
    expect(capsule.contexts[0].stores[0].truncated).toBe(true);
    expect(capsule.contexts[0].stores[0].items.length).toBe(0);
  });

  it('clamps maxChars into the catalog range', async () => {
    const nodeApi = installed({ 'p-notes': [] });
    const low = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true }],
      contextBudget: { maxChars: 1 },
    });
    expect(low.budget.maxChars).toBe(CATALOG_CONSTANTS.contextBudget.minChars);
    const high = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true }],
      contextBudget: { maxChars: 1_000_000 },
    });
    expect(high.budget.maxChars).toBe(CATALOG_CONSTANTS.contextBudget.maxChars);
  });

  it('clamps per-store item limits and forwards maxValueLength', async () => {
    const queries: any[] = [];
    const many = Array.from({ length: 50 }, (_, i) => ({ i }));
    const nodeApi = installed({ 'p-notes': many }, queries);
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true, maxItems: 999 }],
      contextBudget: { maxItemsPerStore: 5, maxValueLength: 100 },
    });
    // requirement.maxItems is clamped, then bounded by the per-fire maxItemsPerStore.
    expect(capsule.contexts[0].stores[0].items.length).toBeLessThanOrEqual(5);
    expect(queries[0].query).toContain('LIMIT 5');
    // maxValueLength below the catalog minimum is raised to the minimum.
    expect(queries[0].opts.maxValueLength).toBe(CATALOG_CONSTANTS.contextBudget.minValueLength);
  });

  it('uses the default budget when none is configured', async () => {
    const nodeApi = installed({ 'p-notes': [{ data: 'small' }] });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true }],
    });
    expect(capsule.budget.maxChars).toBe(CATALOG_CONSTANTS.contextBudget.defaultMaxChars);
    expect(capsule.budget.truncated).toBe(false);
    expect(capsule.contexts[0].stores[0].items).toHaveLength(1);
  });
});
