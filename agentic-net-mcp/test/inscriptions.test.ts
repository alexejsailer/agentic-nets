import { describe, expect, it } from 'vitest';
import { buildInscription, buildAgentInscription, scheduleEmptyFireWarning } from '../src/inscriptions.js';
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

  it('a scheduled http/llm lane re-reads its config token instead of consuming it (repeating fetch)', () => {
    const http: any = buildInscription('http', { id: 't-h', host: 'm@h', inputPlace: 'p-cfg', outputPlace: 'p-raw', scheduleCron: '0 0 5 * * *', url: '${input.data.url}' });
    expect(http.schedule).toEqual({ type: 'cron', cron: '0 0 5 * * *' });
    expect(http.presets.input.consume).toBe(false);
    expect(http.presets.input.optional).toBe(true);
    const llm: any = buildInscription('llm', { id: 't-l', host: 'm@h', inputPlace: 'p-in', outputPlace: 'p-out', intervalMs: 3600000 });
    expect(llm.presets.input.consume).toBe(false);
    // a NON-scheduled http lane still consumes its input (one-shot queue processing)
    const oneShot: any = buildInscription('http', { id: 't-h2', host: 'm@h', inputPlace: 'p-q', outputPlace: 'p-raw', url: '${input.data.url}' });
    expect(oneShot.presets.input.consume).toBe(true);
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
    // auth is normalized to the shape the master's applyAuth actually reads (params.token)
    expect(ins.action.auth).toEqual({ type: 'bearer', params: { token: '${credentials.API_TOKEN}' } });
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

describe('cron validation (guards against silent non-firing schedules)', () => {
  it('accepts a valid 6-field cron', () => {
    expect(() => buildInscription('http', { id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out', scheduleCron: '0 0 8 * * *' })).not.toThrow();
  });

  it('rejects a 5-field (standard crontab) expression with an actionable error', () => {
    expect(() => buildInscription('http', { id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out', scheduleCron: '0 8 * * *' }))
      .toThrow(/6 fields/);
  });

  it('rejects garbage cron input (wrong field count or bad characters)', () => {
    for (const bad of ['every day', '8am', '0 0 8 * * @@@']) {
      expect(() => buildInscription('command', { id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out', scheduleCron: bad })).toThrow();
    }
  });

  it('leaves interval schedules untouched', () => {
    const ins: any = buildInscription('http', { id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out', intervalMs: 60000 });
    expect(ins.schedule).toEqual({ type: 'interval', intervalMs: 60000 });
  });
});

describe('execution mode (add_transition mode: SINGLE | FOREACH)', () => {
  it('defaults to SINGLE when mode is omitted', () => {
    for (const kind of ['map', 'llm', 'http', 'command'] as const) {
      const ins: any = buildInscription(kind, { id: `t-${kind}`, host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' });
      expect(ins.mode).toBe('SINGLE');
    }
  });

  it('threads FOREACH through every kind for per-token fan-out', () => {
    for (const kind of ['map', 'llm', 'http', 'command', 'agent'] as const) {
      const ins: any = buildInscription(kind, { id: `t-${kind}`, host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out', mode: 'FOREACH' });
      expect(ins.mode).toBe('FOREACH');
    }
  });
});

describe('http auth normalization (credentialKey → master params shape)', () => {
  it('bearer credentialKey → params.token with ${credentials.KEY} (what applyAuth reads)', () => {
    const ins: any = buildInscription('http', {
      id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out',
      url: 'https://api/x', auth: { type: 'bearer', credentialKey: 'GH_TOKEN' },
    });
    expect(ins.action.auth).toEqual({ type: 'bearer', params: { token: '${credentials.GH_TOKEN}' } });
  });

  it('api_key credentialKey → params.apiKey + name/in preserved', () => {
    const ins: any = buildInscription('http', {
      id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out',
      url: 'https://api/x', auth: { type: 'api_key', credentialKey: 'K', name: 'X-Api-Key', in: 'header' },
    });
    expect(ins.action.auth).toEqual({ type: 'api_key', params: { apiKey: '${credentials.K}', name: 'X-Api-Key', in: 'header' } });
  });

  it('already-master-shaped auth (params present) passes through unchanged', () => {
    const auth = { type: 'oauth2_client_credentials', params: { tokenUrl: 'https://t', clientId: 'c', clientSecret: '${credentials.S}' } };
    const ins: any = buildInscription('http', { id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out', url: 'https://api/x', auth });
    expect(ins.action.auth).toEqual(auth);
  });
});

describe('verdict routing (add_transition routes: [{place, when}])', () => {
  it('llm: builds one postset + one when-gated emit per route, from @response.json, no catch-all', () => {
    const ins: any = buildInscription('llm', {
      id: 't-review', host: 'm@h:8080', inputPlace: 'p-diff', outputPlace: 'p-out',
      prompt: 'review ${input.data.batchResults}',
      routes: [
        { place: 'p-approved', when: "verdict == 'APPROVE'" },
        { place: 'p-needs-work', when: "verdict == 'NEEDS_WORK'" },
      ],
    });
    expect(ins.postsets.approved.placeId).toBe('p-approved');
    expect(ins.postsets['needs_work'].placeId).toBe('p-needs-work');
    expect(ins.emit).toContainEqual({ to: 'approved', from: '@response.json', when: "verdict == 'APPROVE'" });
    expect(ins.emit).toContainEqual({ to: 'needs_work', from: '@response.json', when: "verdict == 'NEEDS_WORK'" });
    // no unconditional catch-all next to conditionals
    expect(ins.emit.some((e: any) => e.when === undefined)).toBe(false);
    expect(ins.emit).toHaveLength(2);
  });

  it('routes compose with errorPlace (adds an err branch)', () => {
    const ins: any = buildInscription('http', {
      id: 't-h', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out',
      url: 'https://api/x', errorPlace: 'p-err',
      routes: [{ place: 'p-a', when: 'status == 200' }, { place: 'p-b', when: 'status == 404' }],
    });
    expect(ins.postsets.err.placeId).toBe('p-err');
    expect(ins.emit).toContainEqual({ to: 'err', from: '@response', when: 'error' });
    expect(ins.emit.filter((e: any) => e.to !== 'err')).toHaveLength(2);
  });

  it('a route targeting outputPlace reuses the out key (no duplicate postset)', () => {
    const ins: any = buildInscription('map', {
      id: 't-m', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out',
      routes: [{ place: 'p-out', when: "kind == 'x'" }, { place: 'p-other', when: "kind == 'y'" }],
    });
    expect(ins.postsets.out.placeId).toBe('p-out');
    expect(ins.emit).toContainEqual({ to: 'out', from: '@response', when: "kind == 'x'" });
    expect(ins.emit).toContainEqual({ to: 'other', from: '@response', when: "kind == 'y'" });
  });

  it('no routes → unchanged single-emit default', () => {
    const ins: any = buildInscription('llm', { id: 't', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' });
    expect(ins.emit).toEqual([{ to: 'out', from: '@response.json' }]);
    expect(Object.keys(ins.postsets)).toEqual(['out']);
  });
});

describe('llm inscription (add_transition kind:llm — errorPlace)', () => {
  it('adds an err postset and splits success/error emits when errorPlace is set', () => {
    const ins: any = buildInscription('llm', {
      id: 't-llm',
      host: 'm@h:8080',
      inputPlace: 'p-in',
      outputPlace: 'p-out',
      prompt: 'analyze ${input.data.text}',
      errorPlace: 'p-err',
    });
    expect(ins.postsets.err.placeId).toBe('p-err');
    expect(ins.emit).toContainEqual({ to: 'out', from: '@response.json', when: 'success' });
    expect(ins.emit).toContainEqual({ to: 'err', from: '@response', when: 'error' });
  });

  it('keeps the simple single-emit default when no errorPlace', () => {
    const ins: any = buildInscription('llm', { id: 't-llm', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' });
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

describe('scheduled-lane preset semantics (onEmpty)', () => {
  const base = { id: 't-s', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' };

  it('arming a schedule makes the preset optional and non-consuming by default', () => {
    const ins: any = buildInscription('map', { ...base, intervalMs: 30_000, template: { a: 1 } });
    expect(ins.presets.input.optional).toBe(true);
    expect(ins.presets.input.consume).toBe(false);
  });

  it('onEmpty:"skip" keeps the schedule AND-gated with token availability', () => {
    const ins: any = buildInscription('map', {
      ...base,
      intervalMs: 30_000,
      onEmpty: 'skip',
      template: { a: 1 },
    });
    expect(ins.presets.input.optional).toBe(false);
    expect(ins.presets.input.consume).toBe(true);
  });

  it('an unscheduled lane is unaffected by onEmpty', () => {
    const ins: any = buildInscription('map', { ...base, onEmpty: 'fire', template: { a: 1 } });
    expect(ins.presets.input.consume).toBe(true);
    expect(ins.presets.input.optional).toBeUndefined();
  });

  it('applies the same rule across kinds, so scheduling means one thing', () => {
    for (const kind of ['map', 'llm', 'http', 'command'] as const) {
      const ins: any = buildInscription(kind, {
        ...base,
        intervalMs: 30_000,
        onEmpty: 'skip',
        template: { a: 1 },
        prompt: 'p',
        url: 'http://x',
      });
      expect(ins.presets.input.consume, `${kind} preset should consume`).toBe(true);
      expect(ins.presets.input.optional, `${kind} preset should be required`).toBe(false);
    }
  });
});

describe('scheduleEmptyFireWarning', () => {
  const base = { id: 't-s', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' };

  it('warns when a tick-on-empty lane interpolates ${input.*} (emits junk every tick)', () => {
    const w = scheduleEmptyFireWarning({ ...base, intervalMs: 30_000, template: { tick: '${input.data.seq}' } } as any);
    expect(w).toContain('onEmpty');
    expect(w).toContain('t-s');
  });

  it('stays quiet when onEmpty is skip', () => {
    expect(
      scheduleEmptyFireWarning({
        ...base,
        intervalMs: 30_000,
        onEmpty: 'skip',
        template: { tick: '${input.data.seq}' },
      } as any),
    ).toBeNull();
  });

  it('stays quiet for a heartbeat lane that references no input', () => {
    expect(
      scheduleEmptyFireWarning({ ...base, intervalMs: 30_000, template: { probe: 'ping' } } as any),
    ).toBeNull();
  });

  it('stays quiet without a schedule', () => {
    expect(
      scheduleEmptyFireWarning({ ...base, template: { tick: '${input.data.seq}' } } as any),
    ).toBeNull();
  });
});
