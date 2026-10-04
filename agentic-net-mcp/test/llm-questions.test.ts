import { describe, expect, it } from 'vitest';
import { buildInscription } from '../src/inscriptions.js';
import { llmQuestionsSchema, validateLlmModeArgs } from '../src/questions.js';
import { validateKindArgs } from '../src/tools/nets.js';

const questions = {
  route: {
    type: 'choice' as const,
    instructions: 'Which workflow fits?',
    criteria: { research: 'Find information', other: 'Other work' },
  },
};
const base = { id: 't-route', host: 'm@node:8080', inputPlace: 'p-in', outputPlace: 'p-out' };

describe('kind:llm with typed questions', () => {
  it('builds a questions action instead of a prompt, with routable errors', () => {
    const inscription: any = buildInscription('llm', {
      ...base, questions, group: 'jev', questionVersion: 'routing-v1', errorPlace: 'p-err',
    });

    expect(inscription.kind).toBe('llm');
    expect(inscription.action).toMatchObject({
      type: 'llm', group: 'jev', state: '${input.data}', questions, questionVersion: 'routing-v1',
    });
    expect(inscription.action).not.toHaveProperty('nl');
    expect(inscription.emit).toEqual([
      { to: 'out', from: '@response.json', when: 'success' },
      { to: 'err', from: '@response.json', when: 'error' },
    ]);
  });

  it('keeps an explicit state and leaves prompt lanes as they were', () => {
    const typed: any = buildInscription('llm', { ...base, questions, state: { request: '${input.data}' } });
    const prompt: any = buildInscription('llm', { ...base, prompt: 'Classify ${input.data.text}', errorPlace: 'p-err' });

    expect(typed.action.state).toEqual({ request: '${input.data}' });
    expect(prompt.action.nl).toBe('Classify ${input.data.text}');
    expect(prompt.action).not.toHaveProperty('questions');
    expect(prompt.emit.at(-1)).toEqual({ to: 'err', from: '@response', when: 'error' });
  });

  it('rejects mixed or stray mode arguments before anything is written', () => {
    expect(() => validateLlmModeArgs('llm', { questions, prompt: 'x' })).toThrow(/questions replace the prompt/);
    expect(() => validateLlmModeArgs('llm', { prompt: 'x', state: '${input.data}' })).toThrow(/only apply together with questions/);
    expect(() => validateLlmModeArgs('llm', { questions })).not.toThrow();
    expect(() => validateKindArgs('llm', { questions, state: '${input.data}', questionVersion: 'v1' })).not.toThrow();
    expect(() => validateKindArgs('map', { questions })).toThrow(/applies to kind llm/);
  });

  it('validates questions the way master does', () => {
    for (const bad of [
      {},
      { 'route-1': questions.route },
      { route: { type: 'choice', instructions: 'Pick', criteria: { only: 'One' } } },
      { quality: { type: 'score', instructions: 'Rate', criteria: ['Only'] } },
      { urgent: { type: 'probability', instructions: 'Urgent?', criteria: ['a', 'b'] } },
      { x: { type: 'rank', instructions: 'Rank' } },
    ]) {
      expect(() => llmQuestionsSchema.parse(bad)).toThrow();
    }
    expect(llmQuestionsSchema.parse(questions)).toEqual(questions);
  });
});
