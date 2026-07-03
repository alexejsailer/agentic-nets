/**
 * TemplateExecutor against an in-memory fake of the client surface: asserts
 * flow ordering, idempotent 409/422 tolerance, host injection, param
 * substitution, and seed-if-empty semantics — no services required.
 */
import { describe, expect, it } from 'vitest';
import { TemplateExecutor } from '../src/templates/executor.js';
import { TEMPLATES } from '../src/templates/index.js';
import type { AppContext } from '../src/context.js';

class GatewayError extends Error {
  constructor(public status: number) {
    super(`Gateway ${status}`);
    this.name = 'GatewayError';
  }
}

function fakeContext(opts: { duplicates?: Set<string>; seeded?: Set<string> } = {}) {
  const calls: string[] = [];
  const assigned: Record<string, any> = {};
  const tree = new Map<string, any[]>([['root', [{ name: 'workspace', id: 'ws' }]]]);
  tree.set('root/workspace', [
    { name: 'sessions', id: 'sess' },
    { name: 'places', id: 'places' },
  ]);
  tree.set('root/workspace/sessions', [{ name: 'mcp', id: 'mcp-sess' }]);
  tree.set('root/workspace/sessions/mcp', [{ name: 'workspace-nets', id: 'wn' }]);

  const dup = (label: string) => {
    if (opts.duplicates?.has(label)) throw new GatewayError(422);
  };

  const ctx = {
    config: { session: 'mcp', nodeHost: 'nodehost:8080' },
    hostFor: (m: string) => `${m}@nodehost:8080`,
    master: {
      createNet: async (p: any) => {
        calls.push(`net:${p.netId}`);
        dup(`net:${p.netId}`);
      },
      createPlace: async (_net: string, p: any) => {
        calls.push(`place:${p.placeId}`);
        dup(`place:${p.placeId}`);
      },
      createTransition: async (_net: string, p: any) => {
        calls.push(`transition:${p.transitionId}`);
        dup(`transition:${p.transitionId}`);
      },
      createArc: async (_net: string, p: any) => {
        calls.push(`arc:${p.arcId}`);
        dup(`arc:${p.arcId}`);
      },
      assignTransition: async (p: any) => {
        calls.push(`assign:${p.transitionId}`);
        assigned[p.transitionId] = p;
      },
      startTransition: async (id: string) => {
        calls.push(`start:${id}`);
      },
    },
    node: {
      getChildren: async (_m: string, path: string) => tree.get(path) ?? [],
      executeEvents: async (_m: string, events: any[]) => {
        calls.push(...events.map((e: any) => `event:${e.eventType}:${e.name}`));
        return { ok: true };
      },
      getChildrenCount: async (_m: string, path: string) =>
        opts.seeded?.has(path.split('/').pop()!) ? 3 : 0,
    },
    executorFor: () => ({
      execute: async (tool: string, params: any) => {
        calls.push(`exec:${tool}:${params.placeId ?? params.placePath ?? ''}`);
        return { success: true, data: {} };
      },
    }),
  };
  return { ctx: ctx as unknown as AppContext, calls, assigned };
}

describe('TemplateExecutor', () => {
  it('deploys working-memory in the proven order and reports created/started', async () => {
    const { ctx, calls, assigned } = fakeContext();
    const report = await new TemplateExecutor(ctx, 'm1').deploy(TEMPLATES['working-memory']);

    expect(report.created).toContain('net:memory');
    expect(report.started).toEqual(['t-mem-distill']); // links never started
    expect(report.seeded).toContain('p-mem-knowledge');

    // Ordering: designtime net before assigns, assigns before starts
    expect(calls.indexOf('net:memory')).toBeLessThan(calls.indexOf('assign:t-mem-distill'));
    expect(calls.indexOf('assign:t-mem-distill')).toBeLessThan(calls.indexOf('start:t-mem-distill'));

    // Host injection + param substitution into the assigned inscription
    const distill = assigned['t-mem-distill'].inscription;
    expect(distill.presets.input.host).toBe('m1@nodehost:8080');
    expect(distill.action.nl).toMatch(/working memory/);
    expect(distill.action.nl).toContain('${input.data.text}'); // engine-time interpolation survives
  });

  it('tolerates duplicate designtime elements (409/422) as skipped', async () => {
    const { ctx } = fakeContext({ duplicates: new Set(['net:memory', 'place:p-mem-inbox']) });
    const report = await new TemplateExecutor(ctx, 'm1').deploy(TEMPLATES['working-memory']);
    expect(report.skipped).toEqual(expect.arrayContaining(['net:memory', 'place:p-mem-inbox']));
  });

  it('never re-seeds a non-empty place', async () => {
    const { ctx } = fakeContext({ seeded: new Set(['p-mem-knowledge']) });
    const report = await new TemplateExecutor(ctx, 'm1').deploy(TEMPLATES['working-memory']);
    expect(report.seeded).not.toContain('p-mem-knowledge');
    expect(report.skipped).toContain('seed:p-mem-knowledge');
  });

  it('substitutes caller params over defaults', async () => {
    const { ctx, assigned } = fakeContext();
    await new TemplateExecutor(ctx, 'm1').deploy(TEMPLATES['brain'], {
      panelPrompt: 'CUSTOM ${input.data.text}',
    });
    expect(assigned['t-brain-panel'].inscription.action.nl).toBe('CUSTOM ${input.data.text}');
  });
});
