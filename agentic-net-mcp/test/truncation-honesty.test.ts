/**
 * Silence must not read as success.
 *
 * Three limits used to cut data without saying so: read_blob_text's maxLength (a `truncated` flag
 * easy to miss), query_tokens' maxValueLength (a shortened string with no marker at all) and
 * delete_tokens' hard cap of 100 (`{deleted: 100}` indistinguishable from "done"). The worst
 * measured instance: an acceptance gate cleared five places, hit the delete cap, reported success
 * and left 5 snapshots, 13 claims and 3 audits behind; the next run answered from those stale
 * tokens and printed `problems: 0`.
 */
import { describe, expect, it } from 'vitest';
import { compactStories, fieldsAtLength, withCompleteness, UNCAPPED_VALUE_CHARS } from '../src/tools/observe.js';
import { GROUP_KEY_CHARS } from '../src/tools/memory.js';

describe('value caps sent to master', () => {
  /**
   * Master applies maxValueLength as a literal character count, so 0 truncates to NOTHING —
   * while the documented contract, and clampValues on the GET path, read 0 as "uncapped".
   * Measured on the live Desktop 2026-09-19: grouping by dateSource returned the right counts
   * under the keys "...[truncated, 4 chars total]" and "...[truncated, 2 chars total]" instead
   * of "none" and "og". Both call sites therefore send a positive number, never 0.
   */
  it('never sends 0 as an uncapped request', () => {
    expect(UNCAPPED_VALUE_CHARS).toBeGreaterThan(1_000_000);
  });

  it('caps a group key generously but finitely', () => {
    expect(GROUP_KEY_CHARS).toBeGreaterThan(0);
    expect(GROUP_KEY_CHARS).toBeLessThan(UNCAPPED_VALUE_CHARS);
  });
});

describe('withCompleteness', () => {
  it('marks a blob read complete when the text is shorter than the cap', () => {
    const out = withCompleteness({ text: 'short' }, 4000);
    expect(out.complete).toBe(true);
    expect(out.returnedChars).toBe(5);
    expect(out.truncated).toBeUndefined();
  });

  it('marks it incomplete when the text sits exactly on the cap', () => {
    const out = withCompleteness({ text: 'x'.repeat(4000) }, 4000);
    expect(out.complete).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.note).toContain('4000');
    expect(out.note).toContain('do NOT parse this as whole JSON');
  });

  it("believes the store's own truncated flag even below the cap", () => {
    const out = withCompleteness({ text: 'abc', truncated: true }, 4000);
    expect(out.complete).toBe(false);
  });

  it('accepts the flag as a string, because token properties stringify', () => {
    expect(withCompleteness({ text: 'abc', truncated: 'true' }, 4000).complete).toBe(false);
  });

  it('leaves a non-object payload alone', () => {
    expect(withCompleteness('plain', 4000)).toBe('plain');
    expect(withCompleteness(null, 4000)).toBe(null);
  });

  it('reports completeness for an uncapped read', () => {
    const out = withCompleteness({ text: 'x'.repeat(10) }, 0);
    expect(out.complete).toBe(true);
    expect(out.maxLength).toBeUndefined();
  });
});

describe('fieldsAtLength', () => {
  const rows = (data: Record<string, unknown>[]) => data.map((d) => ({ data: d }));

  it('names only the fields cut by the cap', () => {
    const found = fieldsAtLength(rows([{ body: 'x'.repeat(500), title: 'short' }]), 500);
    expect(found).toEqual(['body']);
  });

  it('collects field names across rows, sorted and deduplicated', () => {
    const found = fieldsAtLength(rows([
      { body: 'x'.repeat(500) },
      { body: 'y'.repeat(500), extract: 'z'.repeat(500) },
    ]), 500);
    expect(found).toEqual(['body', 'extract']);
  });

  it('reads properties when data is empty (the runtime place shape)', () => {
    const found = fieldsAtLength([{ data: {}, properties: { summary: 's'.repeat(500) } }], 500);
    expect(found).toEqual(['summary']);
  });

  it('flags nothing when no value reaches the cap', () => {
    expect(fieldsAtLength(rows([{ body: 'x'.repeat(499) }]), 500)).toEqual([]);
  });

  it('flags nothing when values are uncapped', () => {
    expect(fieldsAtLength(rows([{ body: 'x'.repeat(500) }]), 0)).toEqual([]);
  });

  it('ignores non-string values of the same length', () => {
    expect(fieldsAtLength(rows([{ n: 500, list: [1, 2, 3] }]), 500)).toEqual([]);
  });
});

describe('compactStories', () => {
  const story = (over: Record<string, unknown> = {}) => ({
    correlationId: 'corr-1',
    firstSeq: 1,
    lastSeq: 4,
    startedAt: '2026-09-19T10:00:00Z',
    finishedAt: '2026-09-19T10:05:34Z',
    outcome: 'success',
    headline: 'discover finished',
    steps: [{ status: 'started' }, { status: 'success', summary: 'done' }],
    ...over,
  });

  it('drops the steps that carry the payloads and keeps the count', () => {
    const [out] = compactStories([story()]);
    expect(out.steps).toBeUndefined();
    expect(out.stepCount).toBe(2);
  });

  it('computes the duration the operator actually asked for', () => {
    const [out] = compactStories([story()]);
    expect(out.durationMs).toBe(334_000);
  });

  it('omits the duration rather than guessing when a timestamp is missing', () => {
    const [out] = compactStories([story({ finishedAt: undefined })]);
    expect(out.durationMs).toBeUndefined();
  });

  it('carries the error class and the first 200 characters of the error', () => {
    const [out] = compactStories([story({
      outcome: 'error',
      steps: [
        { status: 'started' },
        { status: 'error', summary: 'E'.repeat(500), attributes: { errorClass: 'http-4xx' } },
      ],
    })]);
    expect(out.errorClass).toBe('http-4xx');
    expect(out.error).toHaveLength(201);
    expect(out.error?.endsWith('…')).toBe(true);
  });

  it('falls back to the error attribute when no summary is set', () => {
    const [out] = compactStories([story({
      steps: [{ status: 'error', attributes: { error: 'budget exceeded' } }],
    })]);
    expect(out.error).toBe('budget exceeded');
  });

  it('reports no error fields for a successful fire', () => {
    const [out] = compactStories([story()]);
    expect(out.errorClass).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  it('trims a long headline too', () => {
    const [out] = compactStories([story({ headline: 'H'.repeat(400) })]);
    expect(out.headline).toHaveLength(201);
  });

  it('survives a story with no steps', () => {
    const [out] = compactStories([story({ steps: undefined })]);
    expect(out.stepCount).toBe(0);
  });
});
