/**
 * Every prompt the Focus application brings passes each scope form on the way it can be read:
 * domain:/tag:/net:/any: as a scope, session::net as a net or a scope, a bare word as a level, never a
 * domain scope as a level (the question round read "domain:activity" as a level until Focus 1.5.2, and a
 * file-wide text search hid it from the 1.5.1 fix). Renders the public example's manifest.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptsOfManifest, renderTemplate } from '../src/app-prompts.js';

const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../agentic-net-apps/examples/refiner/agenticos.app.json'), 'utf8'));
const prompts = promptsOfManifest('refiner', manifest.application);

describe('Focus prompts and scope forms', () => {
  it('the manifest brings its prompts', () => {
    expect(prompts.map(p => p.name)).toEqual(expect.arrayContaining(['question-round', 'refinement-pass', 'structure-pass']));
  });

  for (const p of prompts) {
    it(`${p.name}: a domain, tag or net scope is never read as a level`, () => {
      for (const scope of ['domain:activity', 'tag:strength', 'net:rules::power', 'any:sleep']) {
        const text = renderTemplate(p.text, { model: 'm1', scope });
        expect(text, scope).not.toContain(`level:"${scope}"`);
      }
    });
    it(`${p.name}: a bare word stays a level and a session::net is no level`, () => {
      expect(renderTemplate(p.text, { model: 'm1', scope: 'rules::power' })).not.toContain('level:"rules::power"');
      if (p.text.includes('level:"{{scope}}"')) {
        expect(renderTemplate(p.text, { model: 'm1', scope: 'rules' })).toContain('level:"rules"');
      }
    });
  }

  it('the question round reads a domain scope as a scope', () => {
    const qr = prompts.find(p => p.name === 'question-round')!;
    expect(renderTemplate(qr.text, { model: 'm1', scope: 'domain:activity' })).toContain('scope:"domain:activity"');
  });
});
