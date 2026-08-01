import { describe, expect, it } from 'vitest';
import { coverageFromExecutors, coverageWarning } from '../src/tools/observe.js';

const executor = (id: string, models: string[], allowedModels: string[], status = 'ONLINE') => ({
  executorId: id,
  models,
  allowedModels,
  status,
});

describe('coverageFromExecutors', () => {
  it('reports covered when an executor is actually polling the model', () => {
    const cov = coverageFromExecutors([executor('e1', ['safe-teams', 'default'], ['*'])], 'safe-teams');
    expect(cov.state).toBe('READY');
    expect(cov.available).toBe(true);
    expect(cov.covered).toBe(true);
    expect(cov.eligible).toEqual(['e1']);
    expect(cov.polling).toEqual(['e1']);
    expect(cov.allowedButIdle).toEqual([]);
  });

  it('reports STANDBY as available when a wildcard executor has no assignment in the model yet', () => {
    // Desktop Lite starts in this shape: wildcard-eligible, but discovery stays assignment-driven.
    const cov = coverageFromExecutors(
      [executor('agentic-net-executor-default', ['default'], ['*'])],
      'safe-teams',
    );
    expect(cov.state).toBe('STANDBY');
    expect(cov.available).toBe(true);
    expect(cov.covered).toBe(false);
    expect(cov.eligible).toEqual(['agentic-net-executor-default']);
    expect(cov.polling).toEqual([]);
    expect(cov.allowedButIdle).toEqual(['agentic-net-executor-default']);
    expect(cov.online).toEqual(['agentic-net-executor-default']);
  });

  it('reports UNAVAILABLE when every online executor excludes the model', () => {
    const cov = coverageFromExecutors([executor('e1', ['default'], ['default'])], 'safe-teams');
    expect(cov.state).toBe('UNAVAILABLE');
    expect(cov.available).toBe(false);
    expect(cov.covered).toBe(false);
    expect(cov.eligible).toEqual([]);
    expect(cov.allowedButIdle).toEqual([]);
  });

  it('treats a legacy executor with no allowedModels field as unrestricted standby', () => {
    const cov = coverageFromExecutors([{ executorId: 'legacy', models: [], status: 'ONLINE' }], 'new-domain');
    expect(cov.state).toBe('STANDBY');
    expect(cov.available).toBe(true);
    expect(cov.eligible).toEqual(['legacy']);
  });

  it('never counts a stale executor as available', () => {
    const cov = coverageFromExecutors([executor('old', ['safe-teams'], ['*'], 'STALE')], 'safe-teams');
    expect(cov.state).toBe('UNAVAILABLE');
    expect(cov.available).toBe(false);
    expect(cov.online).toEqual([]);
  });

  it('handles an empty registry (nothing online)', () => {
    const cov = coverageFromExecutors([], 'safe-teams');
    expect(cov).toEqual({
      state: 'UNAVAILABLE',
      available: false,
      online: [],
      eligible: [],
      polling: [],
      allowedButIdle: [],
      covered: false,
    });
  });
});

describe('coverageWarning', () => {
  const covered = coverageFromExecutors([executor('e1', ['m'], ['*'])], 'm');
  const standby = coverageFromExecutors([executor('e1', [], ['*'])], 'm');
  const excluded = coverageFromExecutors([executor('e1', [], ['other'])], 'm');
  const none = coverageFromExecutors([], 'm');

  it('returns undefined when coverage is fine', () => {
    expect(coverageWarning(covered, 'm', 3)).toBeUndefined();
  });

  it('returns undefined when uncovered but there are zero command transitions', () => {
    expect(coverageWarning(standby, 'm', 0)).toBeUndefined();
  });

  it('explains automatic activation when an assigned command lane is still in STANDBY', () => {
    const w = coverageWarning(standby, 'safe-teams', 5)!;
    expect(w).toContain("activation is pending for model 'safe-teams'");
    expect(w).toContain('5 command transition(s)');
    expect(w).toContain('e1');
    expect(w).toContain('5s in Desktop Lite');
  });

  it('warns that nothing is ONLINE when the registry is empty', () => {
    const w = coverageWarning(none, 'safe-teams', 2)!;
    expect(w).toContain('No command executor is ONLINE');
  });

  it('does not warn for ordinary standby when command demand is unknown', () => {
    expect(coverageWarning(standby, 'm')).toBeUndefined();
  });

  it('warns when online executors exist but none is eligible', () => {
    const w = coverageWarning(excluded, 'm', 1)!;
    expect(w).toContain('No ONLINE executor is eligible');
  });
});
