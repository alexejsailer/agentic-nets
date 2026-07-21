import { describe, expect, it } from 'vitest';
import { resolveContextCapsule } from '../src/agent/context.js';
import { FRAME, manifest, stubNodeApi } from './context-helpers.js';

/** Mirrors master's AgentContextResolverTest — selection, scoping, preflight failure. */
describe('resolveContextCapsule — selection', () => {
  it('throws when a required context is not installed', async () => {
    const nodeApi = stubNodeApi({ contexts: [] });
    await expect(resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true }],
    })).rejects.toThrow(/Required context 'notes'/);
  });

  it('rejects a required session-scoped context owned by another session', async () => {
    const nodeApi = stubNodeApi({
      contexts: [{
        sessionId: 'ctx-other',
        manifest: manifest('notes', 'session', 'p-notes'),
        origin: { version: '1.0.0', scopeOwnerId: 'other-session' },
      }],
    });
    await expect(resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', scope: 'session', access: 'read', required: true }],
    })).rejects.toThrow(/Required context 'notes'/);
  });

  it('binds the matching context and injects a LIMIT into unbounded queries', async () => {
    const queries: any[] = [];
    const nodeApi = stubNodeApi({
      queries,
      contexts: [{
        sessionId: 'ctx-1',
        manifest: manifest('notes', 'model', 'p-notes'),
        origin: { version: '1.2.0' },
      }],
      tokens: { 'p-notes': [{ data: 'hello' }] },
    });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', version: '^1.0.0', access: 'read', required: true }],
    });
    expect(capsule.contexts).toHaveLength(1);
    expect(capsule.contexts[0].name).toBe('notes');
    expect(capsule.contexts[0].stores[0].items).toHaveLength(1);
    expect(queries[0].query).toMatch(/LIMIT \d+/);
  });

  it('filters version mismatches (required → throws)', async () => {
    const nodeApi = stubNodeApi({
      contexts: [{
        sessionId: 'ctx-1',
        manifest: manifest('notes', 'model', 'p-notes'),
        origin: { version: '2.0.0' },
      }],
    });
    await expect(resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', version: '^1.0.0', access: 'read', required: true }],
    })).rejects.toThrow(/Required context 'notes'/);
  });

  it('prefers the nearest scope when several instances match', async () => {
    const nodeApi = stubNodeApi({
      contexts: [
        {
          sessionId: 'ctx-model',
          manifest: manifest('notes', 'model', 'p-model-notes'),
          origin: { version: '1.0.0' },
        },
        {
          sessionId: 'ctx-session',
          manifest: manifest('notes', 'session', 'p-session-notes'),
          origin: { version: '1.0.0', scopeOwnerId: FRAME.sessionId },
        },
      ],
    });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true }],
    });
    expect(capsule.contexts[0].sessionId).toBe('ctx-session');
  });

  it('required context whose stores are unreadable fails the fire', async () => {
    const nodeApi = stubNodeApi({
      contexts: [{
        sessionId: 'ctx-1',
        manifest: manifest('notes', 'model', 'p-notes'),
        origin: { version: '1.0.0' },
      }],
      tokens: { 'p-notes': () => { throw new Error('node unreachable'); } },
    });
    await expect(resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: true }],
    })).rejects.toThrow(/installed but unreadable/);
  });

  it('optional context with unreadable stores degrades to warnings', async () => {
    const nodeApi = stubNodeApi({
      contexts: [{
        sessionId: 'ctx-1',
        manifest: manifest('notes', 'model', 'p-notes'),
        origin: { version: '1.0.0' },
      }],
      tokens: { 'p-notes': () => { throw new Error('node unreachable'); } },
    });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', access: 'read', required: false }],
    });
    expect(capsule.warnings.some(w => w.includes('Could not read context store'))).toBe(true);
  });
});
