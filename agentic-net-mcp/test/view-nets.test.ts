import { describe, expect, it } from 'vitest';
import { abstractElementIds, classifyCanvas, isAbstractElement, runtimeHomeMap } from '../src/tools/canvas.js';

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

describe('classifyCanvas — abstract elements (subnet refinement)', () => {
  const home = runtimeHomeMap(rows([['t-fetch', 'scout']]));

  it('an inline subnet page or a subnetSession/subnetNet reference marks the element abstract', () => {
    expect(isAbstractElement({ label: 'x', subnet: { net: { places: {}, transitions: {}, arcs: {} } } })).toBe(true);
    expect(isAbstractElement({ label: 'x', subnetSession: 'product', subnetNet: 'account-access' })).toBe(true);
    expect(isAbstractElement({ label: 'x', subnetSession: '', subnetNet: 'account-access' })).toBe(false);
    expect(isAbstractElement({ label: 'x' })).toBe(false);
    expect(isAbstractElement(null)).toBe(false);
    expect(abstractElementIds({
      't-fetch': { label: 'fetch' },
      't-auth': { label: 'auth', subnetSession: 'product', subnetNet: 'account-access' },
      't-legacy': { label: 'legacy', subnet: { net: {} } },
    })).toEqual(['t-auth', 't-legacy']);
  });

  it('a designOnly element is abstract too, so a design net without inscriptions is never stale', () => {
    expect(isAbstractElement({ label: 'x', designOnly: 'true' })).toBe(true);
    expect(isAbstractElement({ label: 'x', designOnly: true })).toBe(true);
    expect(isAbstractElement({ label: 'x', designOnly: 'false' })).toBe(false);
    const ids = abstractElementIds({ 't-pe-steps': { label: 'steps', designOnly: 'true' }, 't-fetch': { label: 'fetch' } });
    expect(ids).toEqual(['t-pe-steps']);
    const c = classifyCanvas(['t-fetch', 't-pe-steps'], home, 'scout', ids);
    expect(c.staleShapes).toEqual([]);
    expect(c.abstractShapes).toEqual(['t-pe-steps']);
  });

  it('an abstract transition with no inscription is abstractShapes, never stale, and keeps the net canonical', () => {
    const c = classifyCanvas(['t-fetch', 't-auth'], home, 'scout', ['t-auth']);
    expect(c.staleShapes).toEqual([]);
    expect(c.abstractShapes).toEqual(['t-auth']);
    expect(c.netRole).toBe('canonical');
  });

  it('without the abstract hint the same shape is stale (what sync_net apply would have deleted)', () => {
    const c = classifyCanvas(['t-fetch', 't-auth'], home, 'scout');
    expect(c.staleShapes).toEqual(['t-auth']);
    expect(c.abstractShapes).toEqual([]);
  });

  it('abstract shapes count as owned on a view canvas, so the role becomes hybrid', () => {
    const c = classifyCanvas(['t-fetch', 't-auth'], home, 'scout-overview', ['t-auth']);
    expect(c.viewShapes).toEqual({ 't-fetch': 'scout' });
    expect(c.netRole).toBe('hybrid');
    expect(c.staleShapes).toEqual([]);
  });
});
