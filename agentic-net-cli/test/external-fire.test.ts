/**
 * The CLI as an external firer.
 *
 * A master with no LLM provider skips its llm/agent lanes, so something outside has to run them.
 * The MCP server could already do it; the CLI could not. These pin the wire calls, because the
 * whole value of this path over `EXECUTE_TRANSITION` is that master keeps binding, emit rules and
 * accounting — which only holds if we talk to the external-fire endpoints exactly.
 */
import { describe, expect, it } from 'vitest';
import { MasterApi } from '../src/gateway/master-api.js';

type Call = { method: string; path: string; body?: any; query?: Record<string, string> };

function apiWithRecorder(response: any = { ok: true }) {
  const calls: Call[] = [];
  const client = {
    masterApi: async (method: string, path: string, body?: any, query?: Record<string, string>) => {
      calls.push({ method, path, body, query });
      return response;
    },
  };
  return { api: new MasterApi(client as any), calls };
}

describe('CLI external fires', () => {
  it('asks for the full AI-lane roster only when told to', () => {
    const { api, calls } = apiWithRecorder();

    api.listAiLanes('m1');
    expect(calls[0].query).toEqual({ modelId: 'm1' });

    api.listAiLanes('m1', { includeAll: true });
    // string, not boolean — query values are serialized verbatim
    expect(calls[1].query).toEqual({ modelId: 'm1', includeAll: 'true' });

    api.listAiLanes('m1', { includeStopped: true });
    expect(calls[2].query).toEqual({ modelId: 'm1', includeStopped: 'true' });
  });

  it('drives the prepare → complete → abandon protocol on the right routes', () => {
    const { api, calls } = apiWithRecorder();

    api.prepareExternalFire('t-classify', 'm1');
    expect(calls[0]).toMatchObject({
      method: 'POST', path: '/transitions/t-classify/external/prepare', body: { modelId: 'm1' },
    });

    api.completeExternalFire('t-classify', 'm1', 'fire-1', { response: '{"verdict":"ok"}', worker: 'cli' });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      path: '/transitions/t-classify/external/complete',
      body: { modelId: 'm1', fireId: 'fire-1', response: '{"verdict":"ok"}', worker: 'cli' },
    });

    api.abandonExternalFire('t-classify', 'm1', 'fire-1');
    expect(calls[2]).toMatchObject({
      method: 'POST', path: '/transitions/t-classify/external/abandon', body: { modelId: 'm1', fireId: 'fire-1' },
    });
  });

  it('marks a lane external explicitly, in both directions', () => {
    const { api, calls } = apiWithRecorder();

    api.setExternal('t-classify', 'm1');
    expect(calls[0].body).toEqual({ modelId: 'm1', external: true });

    api.setExternal('t-classify', 'm1', false);
    expect(calls[1].body).toEqual({ modelId: 'm1', external: false });
  });
});
