import { describe, expect, it } from 'vitest';
import { ALL, getAvailableTools } from '../src/agent/roles.js';
import { CATALOG_CONSTANTS, knownCapabilityProfiles, resolveCapabilityPolicy } from '../src/agent/capabilities.js';
import { canonicalPlaceId, targetKindIfKnown } from '../src/agent/tool-targets.js';
import catalog from '../src/agent/capability-profiles.json';

describe('capability catalog', () => {
  it('is the synced v2 schema', () => {
    expect(catalog.schemaVersion).toBe('2.0');
  });

  it('only references tools that exist in the role registry', () => {
    const known = getAvailableTools(ALL);
    for (const [name, profile] of Object.entries(catalog.profiles)) {
      for (const tool of (profile as { tools: string[] }).tools) {
        expect(known.has(tool as any), `profile ${name} tool ${tool}`).toBe(true);
      }
    }
  });

  it('exposes the shared resolver constants', () => {
    expect(CATALOG_CONSTANTS.contextBudget.defaultMaxChars).toBe(12000);
    expect(CATALOG_CONSTANTS.contextBudget.minChars).toBe(2000);
    expect(CATALOG_CONSTANTS.contextBudget.maxChars).toBe(64000);
    expect(CATALOG_CONSTANTS.contextBudget.charsPerToken).toBe(4);
    expect(CATALOG_CONSTANTS.scopeRank).toEqual(['task', 'agent', 'session', 'model']);
    expect(CATALOG_CONSTANTS.hierarchy.mergeDepth).toBe(5);
    expect(CATALOG_CONSTANTS.hierarchy.nearestDepth).toBe(1);
    expect(CATALOG_CONSTANTS.hierarchy.childToParentRelations)
      .toEqual(['part-of', 'inherits-context', 'parent-context']);
    expect(CATALOG_CONSTANTS.hierarchy.parentToChildRelations)
      .toEqual(['contains', 'context-inherited-by', 'child-context']);
  });

  it('registers every catalog profile', () => {
    const names = knownCapabilityProfiles();
    for (const name of Object.keys(catalog.profiles)) {
      expect(names).toContain(name);
    }
  });

  it('rejects unknown profiles at resolve time', () => {
    expect(() => resolveCapabilityPolicy({ capabilityProfile: 'does-not-exist' }, ALL))
      .toThrow(/Unknown capabilityProfile/);
  });
});

describe('toolTargets classification', () => {
  it('classifies every role-registry tool exactly once (deny-by-default exhaustiveness)', () => {
    for (const tool of getAvailableTools(ALL)) {
      expect(targetKindIfKnown(tool), `tool ${tool} must be classified in toolTargets`)
        .toBeDefined();
    }
    // no duplicates: tool-targets.ts throws at module load, so reaching here covers it
    const groups = catalog.toolTargets;
    const total = groups.read.length + groups.write.length + groups.link.length
      + groups.contextSession.length + groups.structural.length + groups.ambient.length;
    const unique = new Set([...groups.read, ...groups.write, ...groups.link,
      ...groups.contextSession, ...groups.structural, ...groups.ambient]).size;
    expect(unique).toBe(total);
  });

  it('canonicalPlaceId keeps foreign paths fully qualified', () => {
    expect(canonicalPlaceId('p-notes')).toBe('p-notes');
    expect(canonicalPlaceId('root/workspace/places/p-notes')).toBe('p-notes');
    expect(canonicalPlaceId('/root/workspace/places/p-notes')).toBe('p-notes');
    expect(canonicalPlaceId('root/workspace/places/p-notes/tokens')).toBe('p-notes');
    expect(canonicalPlaceId('root/workspace/sessions/s1/pnml/net/places/p-notes'))
      .toBe('root/workspace/sessions/s1/pnml/net/places/p-notes');
    expect(canonicalPlaceId('  ')).toBeUndefined();
    expect(canonicalPlaceId(null)).toBeUndefined();
  });
});
