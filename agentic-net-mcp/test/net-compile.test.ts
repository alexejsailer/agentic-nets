/**
 * The compact-source compiler must reproduce the PROVEN artifacts: the
 * capabilities repo carries place-inspector both as compact source and as the
 * compiled pair that was live-verified on staging (smoke 4/4, 2026-08-29).
 * Compiling the source must yield inscriptions DEEP-EQUAL to that pair.
 * Guarded by existsSync so the suite stays green when the package is built
 * outside the monorepo (e.g. Docker build context without capabilities/).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileNet, type CompactNetSource } from '@agenticos/cli/net/compile';

const PACK = join(__dirname, '..', '..', 'capabilities', 'place-inspector');

const TINY: CompactNetSource = {
  net: 'tiny',
  session: 'agent-tiny',
  transitions: [
    {
      id: 't-a',
      kind: 'map',
      label: 'A',
      reads: { input: 'p-in' },
      writes: { out: 'p-out' },
      template: { x: '${input.data.x}' },
    },
    {
      id: 't-b',
      kind: 'http',
      label: 'B',
      reads: { go: 'p-out' },
      writes: { raw: 'p-raw', err: 'p-fail' },
      http: { url: '${master}/api/x' },
    },
  ],
};

describe('compileNet invariants', () => {
  it('derives arcs, boilerplate presets, and default emits', () => {
    const { net, inscriptions } = compileNet(TINY);
    expect(Object.keys(net.arcs)).toHaveLength(5); // 2 reads + 3 writes
    const [a, b] = inscriptions as any[];
    expect(a.presets.input).toMatchObject({
      placeId: 'p-in',
      arcql: 'FROM $ LIMIT 1',
      take: 'FIRST',
      consume: true,
      optional: false,
    });
    expect(a.emit).toEqual([{ to: 'out', from: '@response' }]);
    expect(a.metadata).toEqual({ sessionId: 'agent-tiny', netId: 'tiny' });
    expect(b.action.url).toBe('http://agentic-net-master:8082/api/x');
    expect(b.emit).toEqual([
      { to: 'raw', from: '@response.json', when: 'success' },
      { to: 'err', from: '@response', when: 'error' },
    ]);
  });

  it('agent without prompt fails loudly; charter map resolves', () => {
    const src: CompactNetSource = {
      net: 'n',
      transitions: [
        { id: 't', kind: 'agent', label: 'x', reads: { task: 'p-t' }, writes: { out: 'p-o' }, agent: { charter: 'c' } },
      ],
    };
    expect(() => compileNet(src)).toThrow(/prompt/);
    const ok = compileNet(src, { charters: { c: 'do the thing\n' } });
    expect((ok.inscriptions[0] as any).action.nl).toBe('do the thing'); // trailing newline stripped
  });

  it('places are auto-collected with labels and every element gets coordinates', () => {
    const { net } = compileNet({ ...TINY, places: { 'p-in': 'The inbox' } });
    expect(net.places['p-in'].label).toBe('The inbox');
    expect(net.places['p-fail'].label).toBe('p-fail');
    for (const el of [...Object.values(net.places), ...Object.values(net.transitions)]) {
      expect(typeof (el as any).x).toBe('number');
      expect(typeof (el as any).y).toBe('number');
    }
  });
});

describe('compileNet vs the live-proven place-inspector artifacts', () => {
  const available = existsSync(join(PACK, 'nets', 'persona-inspector.net.json'));
  it.skipIf(!available)('reproduces the proven inscriptions deep-equal', () => {
    const source = JSON.parse(readFileSync(join(PACK, 'nets', 'persona-inspector.net.json'), 'utf8'));
    const charter = readFileSync(join(PACK, 'charters', 'inspector-parse.md'), 'utf8');
    const proven = JSON.parse(
      readFileSync(join(PACK, 'nets', 'persona-inspector.inscriptions.json'), 'utf8'),
    );
    const { net, inscriptions } = compileNet(source, {
      charters: { 'charters/inspector-parse.md': charter },
    });
    const byId = new Map((proven as any[]).map((i) => [i.id, i]));
    expect(inscriptions).toHaveLength(proven.length);
    for (const built of inscriptions as any[]) {
      expect(built).toEqual(byId.get(built.id));
    }
    const provenNet = JSON.parse(
      readFileSync(join(PACK, 'nets', 'persona-inspector.pnml.json'), 'utf8'),
    ).net;
    expect(Object.keys(net.places).sort()).toEqual(Object.keys(provenNet.places).sort());
    expect(Object.keys(net.transitions).sort()).toEqual(Object.keys(provenNet.transitions).sort());
    const pairs = (arcs: any) => new Set(Object.values(arcs).map((a: any) => `${a.source}>${a.target}`));
    expect(pairs(net.arcs)).toEqual(pairs(provenNet.arcs));
  });
});
