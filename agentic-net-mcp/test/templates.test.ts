import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../src/templates/index.js';
import { validateBlueprint, BlueprintError } from '../src/templates/types.js';

describe('blueprint registry', () => {
  it('ships exactly the five templates', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(['blank', 'brain', 'dev-team', 'watcher', 'working-memory']);
  });

  for (const [id, bp] of Object.entries(TEMPLATES)) {
    it(`${id} passes validation`, () => {
      expect(() => validateBlueprint(bp)).not.toThrow();
    });
  }

  it('every preset in every template has a non-empty arcql (the 400-spam engine gotcha)', () => {
    for (const bp of Object.values(TEMPLATES)) {
      for (const t of bp.transitions) {
        for (const [key, pre] of Object.entries<any>(t.inscription.presets ?? {})) {
          expect(String(pre.arcql ?? '').trim(), `${bp.id}/${t.transitionId}/${key}`).not.toBe('');
        }
      }
    }
  });

  it('link transitions are never started; scheduled ones always are', () => {
    for (const bp of Object.values(TEMPLATES)) {
      for (const t of bp.transitions) {
        if (t.inscription.kind === 'link') expect(t.start, `${bp.id}/${t.transitionId}`).toBe(false);
        if (t.inscription.schedule) expect(t.start, `${bp.id}/${t.transitionId}`).toBe(true);
      }
    }
  });

  it('dev-team is token-free (no llm/agent transitions)', () => {
    for (const t of TEMPLATES['dev-team'].transitions) {
      expect(['map', 'link']).toContain(t.inscription.kind);
    }
  });
});

describe('validateBlueprint regressions', () => {
  const minimal = () => JSON.parse(JSON.stringify(TEMPLATES['working-memory']));

  it('rejects empty preset arcql', () => {
    const bp = minimal();
    bp.transitions[0].inscription.presets.input.arcql = '  ';
    expect(() => validateBlueprint(bp)).toThrow(BlueprintError);
  });

  it('rejects a started link transition', () => {
    const bp = minimal();
    const link = bp.transitions.find((t: any) => t.inscription.kind === 'link');
    link.start = true;
    expect(() => validateBlueprint(bp)).toThrow(/link/);
  });

  it('rejects arcs referencing unknown ids', () => {
    const bp = minimal();
    bp.arcs.push({ arcId: 'a-bad', sourceId: 'p-nope', targetId: 't-mem-distill' });
    expect(() => validateBlueprint(bp)).toThrow(/unknown sourceId/);
  });

  it('rejects malformed cron', () => {
    const bp = minimal();
    bp.transitions[0].inscription.schedule = { type: 'cron', cron: '0 0 3 * *' }; // 5 fields
    expect(() => validateBlueprint(bp)).toThrow(/cron/);
  });
});
