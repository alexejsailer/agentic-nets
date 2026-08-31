import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../src/agent/tool-executor.js';

/**
 * DELETE_PLACE removes ONE canvas shape; the model-wide runtime place always survives,
 * because shared-place partitioning lets several designtime nets draw the same placeId.
 * The guard reports who still uses the place instead of silently orphaning them.
 */
function buildStub() {
  const events: any[] = [];
  const nets: Record<string, any> = {
    'scout-crawl': { net: { places: { 'p-shared': {}, 'p-crawl-only': {} }, transitions: {}, arcs: {} } },
    'scout-analysis': { net: { places: { 'p-shared': {} }, transitions: {}, arcs: {} } },
    'scout-reporting': { net: { places: { 'p-report': {} }, transitions: {}, arcs: {} } },
  };
  const inscriptions: Record<string, any> = {
    't-binds-shared': { kind: 'map', preset: [{ place: 'p-shared', arcql: 'FROM $' }], postset: [{ place: 'p-out' }] },
    't-cmd': { kind: 'command', action: { inputPlace: 'p-shared', outputPlace: 'p-done' } },
    't-elsewhere': { kind: 'map', preset: [{ place: 'p-other' }], postset: [{ place: 'p-out' }] },
  };
  const client = {
    masterApi: async (_method: string, path: string) => {
      if (path === '/designtime/nets') {
        return { totalNets: 3, nets: Object.keys(nets).map((netId) => ({ netId })) };
      }
      const m = path.match(/^\/designtime\/nets\/([^/]+)\/export$/);
      if (m) return nets[m[1]] ?? { net: { places: {}, transitions: {}, arcs: {} } };
      throw new Error(`unexpected masterApi ${path}`);
    },
    nodeApi: async (method: string, path: string, body?: any) => {
      if (method === 'POST' && path.startsWith('/events/execute/')) {
        events.push(...(body?.events ?? []));
        return { ok: true };
      }
      if (path.endsWith('/path/root/workspace/transitions/children')) {
        return Object.keys(inscriptions).map((name, i) => ({ name, id: `uuid-${i}` }));
      }
      const insMatch = path.match(/\/path\/root\/workspace\/transitions\/([^/]+)\/children$/);
      if (insMatch) {
        return [{ name: 'inscription', properties: { value: JSON.stringify(inscriptions[insMatch[1]]) } }];
      }
      // place node resolution: parent children listing for the pnml places path
      if (path.includes('/pnml/net/places/children')) {
        return [
          { name: 'p-shared', id: 'place-node-uuid', parentId: 'places-uuid' },
          { name: 'p-crawl-only', id: 'solo-node-uuid', parentId: 'places-uuid' },
        ];
      }
      throw new Error(`unexpected nodeApi ${method} ${path}`);
    },
  };
  return { executor: new ToolExecutor(client as any, 'research-scout', 'scout'), events };
}

describe('DELETE_PLACE shared-place guard', () => {
  it('deletes only the designtime node and reports every other user of the place', async () => {
    const { executor, events } = buildStub();
    const res = await executor.execute('DELETE_PLACE', { netId: 'scout-crawl', placeId: 'p-shared' });

    expect(res.success).toBe(true);
    expect(res.data.deleted).toBe(true);
    expect(res.data.runtimeKept).toBe(true);
    // Exactly one deleteNode event, aimed at the PNML shape — never a runtime container.
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('deleteNode');
    expect(events[0].id).toBe('place-node-uuid');
    // The other net drawing p-shared, and both binding transitions, are named.
    expect(res.data.stillDrawnIn).toEqual(['scout-analysis']);
    expect(res.data.boundBy).toEqual(expect.arrayContaining(['t-binds-shared', 't-cmd']));
    expect(res.data.boundBy).not.toContain('t-elsewhere');
    expect(res.data.warning).toMatch(/runtime place 'p-shared' and its tokens are intact/);
  });

  it('stays silent when nothing else uses the place', async () => {
    const { executor } = buildStub();
    const res = await executor.execute('DELETE_PLACE', { netId: 'scout-crawl', placeId: 'p-crawl-only' });
    expect(res.success).toBe(true);
    expect(res.data.runtimeKept).toBe(true);
    expect(res.data.warning).toBeUndefined();
    expect(res.data.stillDrawnIn).toBeUndefined();
    expect(res.data.boundBy).toBeUndefined();
  });

  it('a failing guard never turns a successful delete into an error', async () => {
    const { executor } = buildStub();
    // Sabotage the guard's master listing only.
    (executor as any).masterApi.listNets = async () => { throw new Error('gateway down'); };
    const res = await executor.execute('DELETE_PLACE', { netId: 'scout-crawl', placeId: 'p-shared' });
    expect(res.success).toBe(true);
    expect(res.data.deleted).toBe(true);
  });
});
