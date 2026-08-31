import { describe, expect, it } from 'vitest';
import { classifyCanvas, runtimeHomeMap } from '../src/tools/canvas.js';

const rows = (specs: Array<[string, string | null]>) =>
  specs.map(([id, home]) => ({
    transitionId: id,
    inscription: home === null ? {} : { metadata: { netId: home } },
  }));

describe('runtimeHomeMap', () => {
  it('reads metadata.netId from object and string inscriptions, null when absent', () => {
    const home = runtimeHomeMap([
      { transitionId: 't-a', inscription: { metadata: { netId: 'scout' } } },
      { transitionId: 't-b', inscription: JSON.stringify({ metadata: { netId: 'scout' } }) },
      { transitionId: 't-c', inscription: {} },
      { transitionId: 't-d', inscription: 'not json' },
      { id: 't-e' },
      { inscription: {} }, // no id at all — dropped
    ]);
    expect(home.get('t-a')).toBe('scout');
    expect(home.get('t-b')).toBe('scout');
    expect(home.get('t-c')).toBeNull();
    expect(home.get('t-d')).toBeNull();
    expect(home.get('t-e')).toBeNull();
    expect(home.size).toBe(5);
  });
});

describe('classifyCanvas — shared-place partitioning', () => {
  const home = runtimeHomeMap(rows([
    ['t-fetch', 'scout'], ['t-gate', 'scout'], ['t-digest', 'scout'],
  ]));

  it('canonical: every drawn shape is homed here; missing ones are runtimeWithoutShape', () => {
    const c = classifyCanvas(['t-fetch', 't-gate'], home, 'scout');
    expect(c.netRole).toBe('canonical');
    expect(c.staleShapes).toEqual([]);
    expect(c.viewOf).toEqual([]);
    expect(c.undrawn).toEqual(['t-digest']);
  });

  it('view: every shape is backed by runtime homed in ANOTHER net — zero drift, zero undrawn', () => {
    const c = classifyCanvas(['t-fetch', 't-gate'], home, 'scout-crawl');
    expect(c.netRole).toBe('view');
    expect(c.viewOf).toEqual(['scout']);
    expect(c.viewShapes).toEqual({ 't-fetch': 'scout', 't-gate': 'scout' });
    expect(c.staleShapes).toEqual([]);
    // Foreign transitions must NOT flood runtimeWithoutShape on a view canvas.
    expect(c.undrawn).toEqual([]);
  });

  it('stale beats view: a shape with no runtime anywhere is drift even beside view shapes', () => {
    const c = classifyCanvas(['t-fetch', 't-ghost'], home, 'scout-crawl');
    expect(c.staleShapes).toEqual(['t-ghost']);
    expect(c.netRole).toBe('hybrid');
  });

  it('hybrid: a mix of owned and foreign-backed shapes', () => {
    const mixed = runtimeHomeMap(rows([['t-own', 'combo'], ['t-far', 'scout']]));
    const c = classifyCanvas(['t-own', 't-far'], mixed, 'combo');
    expect(c.netRole).toBe('hybrid');
    expect(c.viewShapes).toEqual({ 't-far': 'scout' });
    expect(c.viewOf).toEqual(['scout']);
  });

  it('a home-less runtime transition (no metadata.netId) never counts as undrawn anywhere', () => {
    const anon = runtimeHomeMap(rows([['t-legacy', null]]));
    expect(classifyCanvas([], anon, 'whatever').undrawn).toEqual([]);
    // ...but a drawn shape backed by it counts as owned, not foreign.
    const c = classifyCanvas(['t-legacy'], anon, 'whatever');
    expect(c.netRole).toBe('canonical');
    expect(c.staleShapes).toEqual([]);
  });

  it('empty canvas classifies as empty', () => {
    expect(classifyCanvas([], home, 'scout').netRole).toBe('empty');
  });
});
