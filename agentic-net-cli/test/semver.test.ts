import { describe, expect, it } from 'vitest';
import { versionMatches } from '../src/agent/context.js';
import catalog from '../src/agent/capability-profiles.json';

/**
 * The catalog's semverCases are the shared behavioral pin for version matching:
 * the Java resolver (AgentContextResolver.versionMatches) runs the SAME vectors
 * in CapabilityCatalogTest, so both runtimes must agree case by case.
 */
describe('versionMatches (catalog semverCases)', () => {
  const cases = (catalog as any).constants.semverCases as
    Array<{ constraint: string | null; actual: string | null; matches: boolean }>;

  it('has shared test vectors', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  for (const { constraint, actual, matches } of cases) {
    it(`${constraint ?? '(none)'} vs ${actual ?? '(none)'} → ${matches}`, () => {
      expect(versionMatches(constraint ?? undefined, actual ?? undefined)).toBe(matches);
    });
  }
});
