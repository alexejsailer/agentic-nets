/**
 * Template registry — statically imported so tsup inlines the JSON into the
 * published bundle (npx works from the tarball with no copy step).
 */
import type { TemplateBlueprint } from './types.js';
import workingMemory from './working-memory.json' with { type: 'json' };
import devTeam from './dev-team.json' with { type: 'json' };
import brain from './brain.json' with { type: 'json' };
import blank from './blank.json' with { type: 'json' };
import watcher from './watcher.json' with { type: 'json' };

export const TEMPLATES: Record<string, TemplateBlueprint> = {
  'working-memory': workingMemory as unknown as TemplateBlueprint,
  'dev-team': devTeam as unknown as TemplateBlueprint,
  brain: brain as unknown as TemplateBlueprint,
  blank: blank as unknown as TemplateBlueprint,
  watcher: watcher as unknown as TemplateBlueprint,
};
