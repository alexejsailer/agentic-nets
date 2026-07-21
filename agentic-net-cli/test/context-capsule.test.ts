import { describe, expect, it } from 'vitest';
import { authorizeContextPlace, type ContextCapsule } from '../src/agent/context.js';

/** Mirrors master's ContextCapsuleTest — the capsule's binding/access gate. */
function capsule(access: string, protectedPlaceIds: string[]): ContextCapsule {
  return {
    executionFrame: {
      modelId: 'm', sessionId: 's', transitionId: 't',
      agentInstanceId: 'a', capabilityProfile: 'token-worker',
    },
    contexts: [{
      name: 'domain-context', version: '1.0.0', scope: 'model', access,
      sessionId: 'ctx-1',
      stores: [{ role: 'knowledge', placeId: 'p-knowledge', query: 'FROM $ LIMIT 10', items: [], truncated: false }],
    }],
    budget: { maxChars: 1000, usedChars: 0, truncated: false },
    warnings: [],
    protectedPlaceIds,
  };
}

describe('authorizeContextPlace', () => {
  it('protected context place must be bound and writable for mutation', () => {
    const c = capsule('read', ['p-knowledge', 'p-private']);
    expect(authorizeContextPlace(c, 'QUERY_TOKENS', { placeId: 'p-knowledge' })).toBeUndefined();
    expect(authorizeContextPlace(c, 'CREATE_TOKEN', { placeId: 'p-knowledge' }))
      .toMatch(/read-only/);
    expect(authorizeContextPlace(c, 'QUERY_TOKENS', { placeId: 'p-private' }))
      .toMatch(/not bound/);
    expect(authorizeContextPlace(c, 'CREATE_TOKEN', { placeId: 'p-workflow-out' }))
      .toBeUndefined();
  });

  it('read-write binding allows context mutation', () => {
    const c = capsule('read-write', ['p-knowledge']);
    expect(authorizeContextPlace(c, 'DELETE_TOKEN',
      { placePath: 'root/workspace/places/p-knowledge' })).toBeUndefined();
    expect(authorizeContextPlace(c, 'CONTEXT_ADD_STORE', { sessionId: 'ctx-1' })).toBeUndefined();
    expect(authorizeContextPlace(c, 'CONTEXT_ADD_STORE', { sessionId: 'ctx-other' }))
      .toMatch(/not bound/);
  });

  it('read-only binding cannot reshape context links', () => {
    const c = capsule('read', ['p-knowledge']);
    expect(authorizeContextPlace(c, 'LINK_PLACES', { from: 'p-knowledge', to: 'p-workflow' }))
      .toMatch(/read-only/);
    expect(authorizeContextPlace(c, 'CONTEXT_ADD_STORE', { sessionId: 'ctx-1' }))
      .toMatch(/read-only/);
  });

  it('registry-driven gate covers all place-targeted tools', () => {
    const c = capsule('read', ['p-knowledge']);
    expect(authorizeContextPlace(c, 'GET_PLACE_INFO',
      { placePath: 'root/workspace/places/p-knowledge' })).toBeUndefined();
    expect(authorizeContextPlace(c, 'CREATE_RUNTIME_PLACE', { placeId: 'p-knowledge' }))
      .toMatch(/read-only/);
    // Structural tools stay the capability policy's concern — capsule permits.
    expect(authorizeContextPlace(c, 'SET_INSCRIPTION', { transitionId: 't-x' })).toBeUndefined();
  });

  it('same basename in another tree does not shadow the protected store', () => {
    const c = capsule('read', ['p-knowledge']);
    expect(authorizeContextPlace(c, 'CREATE_TOKEN',
      { placePath: 'root/workspace/places/p-knowledge' })).toMatch(/read-only/);
    expect(authorizeContextPlace(c, 'CREATE_TOKEN',
      { placePath: 'root/workspace/sessions/s1/pnml/net/places/p-knowledge' })).toBeUndefined();
  });
});
