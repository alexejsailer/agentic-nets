import { describe, expect, it } from 'vitest';
import { buildInscription, buildAgentInscription } from '../src/inscriptions.js';
import { compileSteps } from '../src/tools/nets.js';

describe('agent inscription (spawn_persona / add_transition kind:agent)', () => {
  it('builds a valid agent shape with role + tier + autoEmit, modelId derived from host', () => {
    const ins: any = buildInscription('agent', {
      id: 't-x',
      host: 'm@h:8080',
      inputPlace: 'p-in',
      outputPlace: 'p-out',
      role: 'rwxhl',
      tier: 'high',
      nl: 'do it',
      maxIterations: 7,
    });
    expect(ins.kind).toBe('agent');
    expect(ins.role).toBe('rwxhl');
    expect(ins.action.type).toBe('agent');
    // §13 regression: master reads the role EXCLUSIVELY from action.role — a root-only role
    // silently downgraded every MCP-created agent to rw-- (no execute/http/tool-nets).
    expect(ins.action.role).toBe('rwxhl');
    expect(ins.action.modelId).toBe('m');
    expect(ins.action.tier).toBe('high');
    expect(ins.action.maxIterations).toBe(7);
    expect(ins.action.autoEmit).toBe(true);
    expect(ins.action.nl).toBe('do it');
    expect(ins.presets.input.placeId).toBe('p-in');
    expect(ins.presets.input.arcql).toMatch(/^FROM \$/); // never-empty preset arcql (engine gotcha)
    expect(ins.postsets.out.placeId).toBe('p-out');
  });

  it('defaults role to rw-- (reason) and omits tier for the worker model', () => {
    const ins: any = buildAgentInscription({ id: 't-y', host: 'safe-teams@localhost:8080', inputPlace: 'p-a', outputPlace: 'p-b' });
    expect(ins.role).toBe('rw--');
    expect(ins.action.role).toBe('rw--');
    expect(ins.action.modelId).toBe('safe-teams');
    expect(ins.action.tier).toBeUndefined();
  });

  it('a scheduled agent watches (non-consuming, optional preset) instead of draining its inbox', () => {
    const ins: any = buildAgentInscription({ id: 't-z', host: 'm@h', inputPlace: 'p-a', outputPlace: 'p-b', intervalMs: 60000 });
    expect(ins.schedule).toEqual({ type: 'interval', intervalMs: 60000 });
    expect(ins.presets.input.consume).toBe(false);
    expect(ins.presets.input.optional).toBe(true);
  });
});

describe('command inscription (add_transition kind:command — executor selection)', () => {
  it('puts an explicit executorId into action.executorId', () => {
    const ins: any = buildInscription('command', {
      id: 't-cmd',
      host: 'm@h:8080',
      inputPlace: 'p-in',
      outputPlace: 'p-out',
      executorId: 'agentic-net-executor-2',
    });
    expect(ins.kind).toBe('command');
    expect(ins.action.type).toBe('command');
    expect(ins.action.executorId).toBe('agentic-net-executor-2');
  });

  it('omits action.executorId entirely when none is given (default executor)', () => {
    const ins: any = buildInscription('command', { id: 't-cmd', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' });
    expect(ins.action.type).toBe('command');
    expect('executorId' in ins.action).toBe(false);
  });
});

describe('http inscription (add_transition kind:http — headers/body/auth/errorPlace)', () => {
  it('threads headers, body, and an auth block into the http action', () => {
    const ins: any = buildInscription('http', {
      id: 't-http',
      host: 'm@h:8080',
      inputPlace: 'p-in',
      outputPlace: 'p-out',
      method: 'POST',
      url: 'https://api/x',
      headers: { 'X-Api-Key': '${credentials.KEY}' },
      body: { q: '${input.data.q}' },
      auth: { type: 'bearer', credentialKey: 'API_TOKEN' },
    });
    expect(ins.action.type).toBe('http');
    expect(ins.action.method).toBe('POST');
    expect(ins.action.headers['X-Api-Key']).toBe('${credentials.KEY}');
    expect(ins.action.body).toEqual({ q: '${input.data.q}' });
    expect(ins.action.auth).toEqual({ type: 'bearer', credentialKey: 'API_TOKEN' });
  });

  it('adds an err postset and splits success/error emits when errorPlace is set', () => {
    const ins: any = buildInscription('http', {
      id: 't-http',
      host: 'm@h:8080',
      inputPlace: 'p-in',
      outputPlace: 'p-out',
      errorPlace: 'p-err',
    });
    expect(ins.postsets.err.placeId).toBe('p-err');
    expect(ins.emit).toContainEqual({ to: 'out', from: '@response.json', when: 'success' });
    expect(ins.emit).toContainEqual({ to: 'err', from: '@response', when: 'error' });
  });

  it('keeps the simple single-emit default when no errorPlace', () => {
    const ins: any = buildInscription('http', { id: 't-http', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' });
    expect(ins.emit).toEqual([{ to: 'out', from: '@response.json' }]);
    expect('err' in ins.postsets).toBe(false);
  });
});

describe('compileSteps (session crystallization → replayable script)', () => {
  it('compiles shell + {command} + {method,url} steps into one set -e script', () => {
    const { script, count } = compileSteps([
      'echo hi',
      { command: 'ls -la' },
      { method: 'post', url: 'http://x/y', headers: { 'X-A': '1' }, body: { k: 1 }, note: 'call it' },
    ]);
    expect(count).toBe(3);
    expect(script.startsWith('set -e')).toBe(true);
    expect(script).toContain('echo hi');
    expect(script).toContain('ls -la');
    expect(script).toContain('curl -sS -X POST');
    expect(script).toContain('http://x/y');
    expect(script).toContain('X-A: 1');
    expect(script).toContain('# call it');
  });

  it('counts nothing for empty / unrecognized steps', () => {
    expect(compileSteps([{}, { foo: 'bar' }]).count).toBe(0);
    expect(compileSteps([]).count).toBe(0);
  });
});
