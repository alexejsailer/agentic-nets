import { describe, expect, it } from 'vitest';
import { COL, NetLayout, ORIGIN_X, ORIGIN_Y, ROW } from '../src/layout.js';

/**
 * Field report: MCP-built nets stacked every element on one or two points — add_place always
 * (100,100), add_transition a 60px column at x=200 for EVERY call. These tests pin the
 * replacement: a deterministic place → transition → place spine with 200/180px pitch that
 * never moves an existing element.
 */
describe('NetLayout — incremental designtime layout', () => {
  it('lays a fresh transition out as a left-to-right spine from the origin', () => {
    const l = new NetLayout();
    const plan = l.planTransition({ transitionId: 't-1', inputPlace: 'p-in', outputPlace: 'p-out' });
    expect(plan.places.get('p-in')).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
    expect(plan.transition).toEqual({ x: ORIGIN_X + COL, y: ORIGIN_Y });
    expect(plan.places.get('p-out')).toEqual({ x: ORIGIN_X + 2 * COL, y: ORIGIN_Y });
  });

  it('continues the spine of an existing input place instead of restarting at the origin', () => {
    const l = new NetLayout([{ id: 'p-mid', x: 500, y: 100 }]);
    const plan = l.planTransition({ transitionId: 't-2', inputPlace: 'p-mid', outputPlace: 'p-end' });
    expect(plan.places.has('p-mid')).toBe(false); // existing → never re-emitted, never moved
    expect(plan.transition).toEqual({ x: 700, y: 100 });
    expect(plan.places.get('p-end')).toEqual({ x: 900, y: 100 });
  });

  it('chained add_transition calls produce a non-overlapping pipeline', () => {
    const l = new NetLayout();
    const a = l.planTransition({ transitionId: 't-a', inputPlace: 'p-1', outputPlace: 'p-2' });
    const b = l.planTransition({ transitionId: 't-b', inputPlace: 'p-2', outputPlace: 'p-3' });
    const points = [
      a.places.get('p-1')!, a.transition, a.places.get('p-2')!,
      b.transition, b.places.get('p-3')!,
    ];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const overlapping = Math.abs(points[i].x - points[j].x) < 100 && Math.abs(points[i].y - points[j].y) < 100;
        expect(overlapping, `points ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  it('an unrelated second chain starts on a fresh row below everything', () => {
    const l = new NetLayout();
    l.planTransition({ transitionId: 't-a', inputPlace: 'p-1', outputPlace: 'p-2' });
    const b = l.planTransition({ transitionId: 't-b', inputPlace: 'p-x', outputPlace: 'p-y' });
    expect(b.places.get('p-x')!.y).toBeGreaterThanOrEqual(ORIGIN_Y + ROW);
    expect(b.places.get('p-x')!.x).toBe(ORIGIN_X);
  });

  it('branch places fan out on the row below the transition', () => {
    const l = new NetLayout();
    const plan = l.planTransition({
      transitionId: 't-r', inputPlace: 'p-in', outputPlace: 'p-out',
      branchPlaces: ['p-approved', 'p-rejected'],
    });
    const t = plan.transition;
    const approved = plan.places.get('p-approved')!;
    const rejected = plan.places.get('p-rejected')!;
    expect(approved).toEqual({ x: t.x + COL, y: t.y + ROW });
    // second branch slides down another row rather than stacking
    expect(rejected.x).toBe(t.x + COL);
    expect(rejected.y).toBeGreaterThanOrEqual(t.y + 2 * ROW);
  });

  it('explicit x/y anchors the transition and spaces the new places around it with real pitch', () => {
    const l = new NetLayout();
    const plan = l.planTransition({ transitionId: 't-e', inputPlace: 'p-i', outputPlace: 'p-o', x: 600, y: 400 });
    expect(plan.transition).toEqual({ x: 600, y: 400 });
    expect(plan.places.get('p-i')).toEqual({ x: 600 - COL, y: 400 });
    expect(plan.places.get('p-o')).toEqual({ x: 600 + COL, y: 400 });
  });

  it('nextSlot fills a grid without overlapping existing elements', () => {
    const l = new NetLayout([
      { id: 'a', x: 100, y: 100 },
      { id: 'b', x: 300, y: 100 },
    ]);
    expect(l.nextSlot('c')).toEqual({ x: 500, y: 100 });
    expect(l.nextSlot('d')).toEqual({ x: 700, y: 100 });
  });

  it('ignores elements with missing coordinates instead of treating them as (0,0)', () => {
    const l = new NetLayout([{ id: 'ghost', x: null, y: undefined as any }]);
    expect(l.has('ghost')).toBe(false);
    expect(l.nextSlot('first')).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
  });
});
