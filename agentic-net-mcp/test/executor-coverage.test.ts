import { describe, expect, it } from 'vitest';
import { coverageFromExecutors, coverageWarning } from '../src/tools/observe.js';

const executor = (id: string, models: string[], allowedModels: string[]) => ({
  executorId: id,
  models,
  allowedModels,
});

describe('coverageFromExecutors', () => {
  it('reports covered when an executor is actually polling the model', () => {
    const cov = coverageFromExecutors([executor('e1', ['safe-teams', 'default'], ['*'])], 'safe-teams');
    expect(cov.covered).toBe(true);
    expect(cov.polling).toEqual(['e1']);
    expect(cov.allowedButIdle).toEqual([]);
  });

  it('flags allowedButIdle: allowed to serve the model but not polling it (the post-restart stall)', () => {
    // The exact staging shape on 2026-07-13: one executor, allowedModels ["*"], only polling "default".
    const cov = coverageFromExecutors(
      [executor('agentic-net-executor-default', ['default'], ['*'])],
      'safe-teams',
    );
    expect(cov.covered).toBe(false);
    expect(cov.polling).toEqual([]);
    expect(cov.allowedButIdle).toEqual(['agentic-net-executor-default']);
    expect(cov.online).toEqual(['agentic-net-executor-default']);
  });

  it('does not list an executor as allowedButIdle when its allowlist excludes the model', () => {
    const cov = coverageFromExecutors([executor('e1', ['default'], ['default'])], 'safe-teams');
    expect(cov.covered).toBe(false);
    expect(cov.allowedButIdle).toEqual([]);
  });

  it('handles an empty registry (nothing online)', () => {
    const cov = coverageFromExecutors([], 'safe-teams');
    expect(cov).toEqual({ online: [], polling: [], allowedButIdle: [], covered: false });
  });
});

describe('coverageWarning', () => {
  const covered = { online: ['e1'], polling: ['e1'], allowedButIdle: [] as string[], covered: true };
  const idle = { online: ['e1'], polling: [] as string[], allowedButIdle: ['e1'], covered: false };
  const none = { online: [] as string[], polling: [] as string[], allowedButIdle: [] as string[], covered: false };

  it('returns undefined when coverage is fine', () => {
    expect(coverageWarning(covered, 'm', 3)).toBeUndefined();
  });

  it('returns undefined when uncovered but there are zero command transitions', () => {
    expect(coverageWarning(idle, 'm', 0)).toBeUndefined();
  });

  it('warns (naming the allowed-but-idle executor) when command lanes have no polling executor', () => {
    const w = coverageWarning(idle, 'safe-teams', 5)!;
    expect(w).toContain("No executor is polling model 'safe-teams'");
    expect(w).toContain('5 command transition(s)');
    expect(w).toContain('e1');
  });

  it('warns that nothing is ONLINE when the registry is empty', () => {
    const w = coverageWarning(none, 'safe-teams', 2)!;
    expect(w).toContain('No command executor is ONLINE');
  });

  it('still warns without a known command count (list_executors path) when uncovered', () => {
    expect(coverageWarning(idle, 'm')).toBeDefined();
  });
});
