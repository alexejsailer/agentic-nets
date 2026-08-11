import { describe, expect, it } from 'vitest';
import { domainMemoryTokenData, memoryTokenData } from '../src/tools/memory.js';

/**
 * Field finding F13b: memory_write's provenance metadata silently OVERWROTE same-named user
 * data fields — `data: {source: "abnahme-test"}` was stored as `source: "mcp"`, and a
 * downstream template interpolated the wrong value. The merge order now puts tool defaults
 * first, so user data always wins; only explicit args (text/tags/type) still override data.
 */
describe('memory token payload merge order (F13b)', () => {
  it('user data fields win over the tool provenance defaults', () => {
    const d = memoryTokenData({ data: { source: 'abnahme-test', createdAt: '2026-01-01T00:00:00Z', kind: 'test_fehler' } });
    expect(d.source).toBe('abnahme-test');
    expect(d.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(d.kind).toBe('test_fehler');
  });

  it('provenance defaults still apply when the user does not name them', () => {
    const d = memoryTokenData({ text: 'note' });
    expect(d.source).toBe('mcp');
    expect(d.kind).toBe('memory');
    expect(typeof d.createdAt).toBe('string');
    expect(d.text).toBe('note');
  });

  it('explicit args (text, tags) override data — the caller typed them deliberately', () => {
    const d = memoryTokenData({ text: 'explicit', data: { text: 'from-data', tags: 'raw' }, tags: ['a', 'b'] });
    expect(d.text).toBe('explicit');
    expect(d.tags).toBe(JSON.stringify(['a', 'b']));
  });

  it('data-only tags survive when the tags arg is absent', () => {
    const d = memoryTokenData({ data: { tags: 'keep-me' } });
    expect(d.tags).toBe('keep-me');
  });

  it('domain_memory_write follows the same order (content/type explicit, data wins over defaults)', () => {
    const d = domainMemoryTokenData({ data: { source: 'field-report', type: 'from-data' }, type: 'insight' });
    expect(d.source).toBe('field-report');
    expect(d.kind).toBe('domain-memory');
    expect(d.type).toBe('insight'); // explicit arg beats the data field
  });
});
