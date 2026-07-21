import { describe, expect, it } from 'vitest';
import { resolveContextCapsule } from '../src/agent/context.js';
import { FRAME, manifest, stubNodeApi } from './context-helpers.js';

/** Mirrors master's hierarchy expansion — policies, depth, read-only inheritance. */
describe('resolveContextCapsule — hierarchy', () => {
  const child = {
    sessionId: 'ctx-child',
    manifest: manifest('notes', 'session', 'p-child',
      { resolution: 'merge', readPolicy: 'local-first' }),
    origin: { version: '1.0.0', scopeOwnerId: FRAME.sessionId },
  };
  const parent = {
    sessionId: 'ctx-parent',
    manifest: manifest('domain-context', 'model', 'p-parent'),
    origin: { version: '1.0.0' },
  };
  const link = {
    transitionId: 't-link-inherit',
    relation: 'inherits-context',
    from: 'p-child',
    to: 'p-parent',
  };

  it('nearest child loads its linked parent read-only (local-first order)', async () => {
    const nodeApi = stubNodeApi({ contexts: [child, parent], links: [link] });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', scope: 'nearest', access: 'read-write', required: true }],
    });
    expect(capsule.contexts.map(c => c.name)).toEqual(['notes', 'domain-context']);
    expect(capsule.contexts[0].access).toBe('read-write');
    expect(capsule.contexts[1].access).toBe('read');
  });

  it('parent-first read policy reverses the order', async () => {
    const parentFirstChild = {
      ...child,
      manifest: manifest('notes', 'session', 'p-child',
        { resolution: 'merge', readPolicy: 'parent-first' }),
    };
    const nodeApi = stubNodeApi({ contexts: [parentFirstChild, parent], links: [link] });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', scope: 'nearest', access: 'read-write', required: true }],
    });
    expect(capsule.contexts.map(c => c.name)).toEqual(['domain-context', 'notes']);
  });

  it('local-only never expands to parents', async () => {
    const localOnly = {
      ...child,
      manifest: manifest('notes', 'session', 'p-child',
        { resolution: 'merge', readPolicy: 'local-only' }),
    };
    const nodeApi = stubNodeApi({ contexts: [localOnly, parent], links: [link] });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', scope: 'nearest', access: 'read', required: true }],
    });
    expect(capsule.contexts.map(c => c.name)).toEqual(['notes']);
  });

  it('an explicit writable binding upgrades an inherited read-only duplicate', async () => {
    const nodeApi = stubNodeApi({ contexts: [child, parent], links: [link] });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [
        { name: 'notes', scope: 'nearest', access: 'read-write', required: true },
        { name: 'domain-context', scope: 'model', access: 'read-write', required: true },
      ],
    });
    expect(capsule.contexts.map(c => `${c.name}:${c.access}`))
      .toEqual(['notes:read-write', 'domain-context:read-write']);
  });

  it('cycles between contexts terminate (seen-set)', async () => {
    const backLink = {
      transitionId: 't-link-back',
      relation: 'inherits-context',
      from: 'p-parent',
      to: 'p-child',
    };
    const cyclicParent = {
      ...parent,
      manifest: manifest('domain-context', 'model', 'p-parent',
        { resolution: 'merge', readPolicy: 'local-first' }),
    };
    const nodeApi = stubNodeApi({ contexts: [child, cyclicParent], links: [link, backLink] });
    const capsule = await resolveContextCapsule(nodeApi, FRAME, {
      contextBindings: [{ name: 'notes', scope: 'nearest', access: 'read', required: true }],
    });
    expect(capsule.contexts.map(c => c.name)).toEqual(['notes', 'domain-context']);
  });
});
