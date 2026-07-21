import { describe, expect, it } from 'vitest';
import { READ_WRITE, parseRole } from '../src/agent/roles.js';
import { resolveCapabilityPolicy } from '../src/agent/capabilities.js';

/** Mirrors master's AgentCapabilityPolicyTest — same semantics, same denial shapes. */
describe('resolveCapabilityPolicy', () => {
  it('proposal-writer can append but cannot mutate topology', () => {
    const role = parseRole('rw--l-----');
    const policy = resolveCapabilityPolicy({
      capabilityProfile: 'proposal-writer',
      resourceScopes: { writePlaces: ['p-cryst-proposals', 'p-cryst-journal'] },
    }, role);

    expect(policy.tools.has('CREATE_TOKEN')).toBe(true);
    expect(policy.tools.has('QUERY_EVENTS')).toBe(true);
    expect(policy.tools.has('SET_INSCRIPTION')).toBe(false);
    expect(policy.authorize('CREATE_TOKEN',
      { placePath: 'root/workspace/places/p-cryst-proposals' })).toBeUndefined();
    expect(policy.authorize('CREATE_TOKEN',
      { placePath: 'root/workspace/places/p-operational' })).toMatch(/outside resourceScopes/);
  });

  it('explicit allowedTools can only narrow the role', () => {
    const policy = resolveCapabilityPolicy(
      { allowedTools: ['QUERY_TOKENS', 'CREATE_TOKEN'] }, parseRole('r'));
    expect(policy.tools.has('QUERY_TOKENS')).toBe(true);
    expect(policy.tools.has('DONE')).toBe(true);
    expect(policy.tools.has('CREATE_TOKEN')).toBe(false);
  });

  it('place-scoped grant denies structural mutations', () => {
    const policy = resolveCapabilityPolicy(
      { resourceScopes: { writePlaces: ['p-outbox'] } }, READ_WRITE);

    expect(policy.tools.has('SET_INSCRIPTION')).toBe(true);
    expect(policy.authorize('SET_INSCRIPTION', { transitionId: 't-x' }))
      .toMatch(/structural mutations/);
    expect(policy.authorize('CREATE_TOKEN', { placeId: 'p-outbox' })).toBeUndefined();
    expect(policy.authorize('QUERY_TOKENS',
      { placePath: 'root/workspace/places/p-anywhere' })).toBeUndefined();
  });

  it('link endpoints are checked against writePlaces', () => {
    const policy = resolveCapabilityPolicy(
      { resourceScopes: { writePlaces: ['p-a', 'p-b'] } }, READ_WRITE);

    expect(policy.authorize('LINK_PLACES', { from: 'p-a', to: 'p-b' })).toBeUndefined();
    expect(policy.authorize('LINK_PLACES', { from: 'p-a', to: 'p-elsewhere' }))
      .toMatch(/link endpoint/);
  });

  it('unrestricted legacy policies see no new denials', () => {
    const policy = resolveCapabilityPolicy({}, READ_WRITE);
    expect(policy.authorize('SET_INSCRIPTION', { transitionId: 't-x' })).toBeUndefined();
    expect(policy.authorize('CREATE_TOKEN', { placeId: 'p-anywhere' })).toBeUndefined();
  });

  it('reports tools capped by the role ceiling', () => {
    const policy = resolveCapabilityPolicy(
      { capabilityProfile: 'mailbox-orchestrator' }, READ_WRITE);
    expect([...policy.cappedTools]).toEqual(['AWAIT_TOKEN']);

    const research = resolveCapabilityPolicy(
      { capabilityProfile: 'research-worker' }, READ_WRITE);
    expect([...research.cappedTools]).toEqual(['HTTP_CALL']);

    const fits = resolveCapabilityPolicy(
      { capabilityProfile: 'proposal-writer' }, parseRole('rw--l-----'));
    expect(fits.cappedTools.size).toBe(0);
  });

  it('session scope applies to every tool', () => {
    const policy = resolveCapabilityPolicy(
      { resourceScopes: { sessions: ['s-allowed'] } }, READ_WRITE);
    expect(policy.authorize('CREATE_TOKEN', { placeId: 'p-x', sessionId: 's-allowed' }))
      .toBeUndefined();
    expect(policy.authorize('CREATE_TOKEN', { placeId: 'p-x', sessionId: 's-other' }))
      .toMatch(/outside resourceScopes/);
  });
});
