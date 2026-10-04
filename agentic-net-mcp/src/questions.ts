import { z } from 'zod';

/**
 * Typed questions of a kind:llm transition (action.questions). Mirrors master's TypedQuestions:
 * a question that would fail on master fails here, before anything is written.
 */
const text = z.string().trim().min(1);

const question = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    instructions: text,
    criteria: z.record(text, text).refine((v) => Object.keys(v).length >= 2, 'a choice needs at least two options'),
  }).strict(),
  z.object({
    type: z.literal('score'),
    instructions: text,
    criteria: z.array(text).min(2, 'a score needs at least two levels, low to high'),
  }).strict(),
  z.object({ type: z.literal('probability'), instructions: text }).strict(),
]);

export const llmQuestionsSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'question ids are letters, digits and underscores (they are emit paths)'), question)
  .refine((v) => Object.keys(v).length > 0, 'give at least one question');

export type LlmQuestions = z.infer<typeof llmQuestionsSchema>;

/**
 * The two llm modes exclude each other: questions replace the prompt (master rejects both), and
 * state/questionVersion mean nothing without questions. Throws BEFORE any write.
 */
export function validateLlmModeArgs(kind: string, args: Record<string, any>): void {
  if (kind !== 'llm') return;
  if (args.questions !== undefined) {
    if (args.prompt !== undefined) {
      throw new Error('llm: questions replace the prompt. Give questions (+ state) or prompt, not both; '
        + 'put guidance into each question\'s instructions');
    }
    llmQuestionsSchema.parse(args.questions);
    return;
  }
  const stray = ['state', 'questionVersion'].filter((k) => args[k] !== undefined);
  if (stray.length) {
    throw new Error(`llm: ${stray.join(', ')} only apply together with questions`);
  }
}
