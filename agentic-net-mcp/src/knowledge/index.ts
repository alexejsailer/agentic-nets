/**
 * The bundled knowledge pack — the operational docs that make an MCP client as effective as a
 * developer with the source tree. Real .md files (tsup `loader: {'.md':'text'}` inlines them into
 * the bundle; vitest mirrors it), served as `agenticnets://docs/{topic}` resources and searched by
 * the `search_knowledge` tool.
 *
 * Authoring rules (enforced by test/knowledge-leaks.test.ts):
 * - CURATED content only — never verbatim CLAUDE.md/private-doc copies; no credentials, IPs,
 *   personal paths, CI internals, or internal hostnames (the leak gate scans every byte shipped).
 * - Per-doc hard cap 8 KB (target 2-5 KB), whole pack 80 KB. A topic that outgrows the cap splits.
 * - Every doc starts with a single `# Title` line; sections use `##` (the search index splits on
 *   them); topic keys are lowercase.
 */
import architectureMd from './architecture.md';
import arcqlMd from './arcql.md';
import commandsMd from './commands.md';
import conceptsMd from './concepts.md';
import costMd from './cost.md';
import emitMd from './emit.md';
import externalFireMd from './external-fire.md';
import indexMd from './index.md';
import nethubMd from './nethub.md';
import inscriptionsMd from './inscriptions.md';
import interpolationMd from './interpolation.md';
import llmMd from './llm.md';
import realAgentsMd from './real-agents.md';
import recipesMd from './recipes.md';
import schedulingMd from './scheduling.md';
import securityMd from './security.md';
import tokensMd from './tokens.md';
import toolCatalogMd from './tool-catalog.md';
import troubleshootingMd from './troubleshooting.md';

export interface KnowledgeDoc {
  title: string;
  text: string;
}

export const KNOWLEDGE: Record<string, KnowledgeDoc> = {
  index: { title: 'Start here: the knowledge base', text: indexMd },
  concepts: { title: 'Agentic-Nets concepts', text: conceptsMd },
  architecture: { title: 'Two layers: PNML vs runtime', text: architectureMd },
  inscriptions: { title: 'Inscriptions: per-kind reference', text: inscriptionsMd },
  arcql: { title: 'ArcQL reference', text: arcqlMd },
  interpolation: { title: 'Templates: ${...} and the function set', text: interpolationMd },
  emit: { title: 'Emit rules & token-loss prevention', text: emitMd },
  commands: { title: 'Command lanes: token schema + executors', text: commandsMd },
  'tool-catalog': { title: 'The Tool Catalog: four flags, two scopes', text: toolCatalogMd },
  llm: { title: 'LLM transitions: the riskiest kind', text: llmMd },
  'external-fire': { title: 'External fires: the host model is the LLM', text: externalFireMd },
  'real-agents': { title: 'Real agents: personas scheduled on Petri nets', text: realAgentsMd },
  scheduling: { title: 'Scheduling: nets that run unattended', text: schedulingMd },
  cost: { title: 'Watching the meter: token cost', text: costMd },
  nethub: { title: 'NetHub: export, import, self-contained packages', text: nethubMd },
  tokens: { title: 'Token shapes, stringification, size', text: tokensMd },
  troubleshooting: { title: 'Troubleshooting playbooks', text: troubleshootingMd },
  recipes: { title: 'Recipes', text: recipesMd },
  security: { title: 'Scope & security model', text: securityMd },
};

export interface KnowledgeSearchResult {
  topic: string;
  title: string;
  heading: string;
  uri: string;
  score: number;
  excerpt: string;
}

interface Section {
  topic: string;
  title: string;
  heading: string;
  body: string;
  bodyLower: string;
  headingLower: string;
  titleLower: string;
}

let sectionIndex: Section[] | null = null;

/** Split every doc into ##-sections once (title-level # is the doc title). */
function index(): Section[] {
  if (sectionIndex) return sectionIndex;
  const sections: Section[] = [];
  for (const [topic, doc] of Object.entries(KNOWLEDGE)) {
    const parts = doc.text.split(/^## /m);
    // parts[0] = preamble under the # title; the rest start with their heading line.
    const push = (heading: string, body: string) => {
      if (!body.trim()) return;
      sections.push({
        topic,
        title: doc.title,
        heading,
        body,
        bodyLower: body.toLowerCase(),
        headingLower: heading.toLowerCase(),
        titleLower: doc.title.toLowerCase(),
      });
    };
    push('(intro)', parts[0] ?? '');
    for (const part of parts.slice(1)) {
      const nl = part.indexOf('\n');
      const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
      push(heading, nl === -1 ? '' : part.slice(nl + 1));
    }
  }
  sectionIndex = sections;
  return sections;
}

function countOccurrences(haystack: string, needle: string, cap: number): number {
  let count = 0;
  let idx = 0;
  while (count < cap && (idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function excerptAround(body: string, at: number, term: string): string {
  const start = Math.max(0, at - 160);
  const end = Math.min(body.length, at + term.length + 160);
  const raw = (start > 0 ? '…' : '') + body.slice(start, end).trim() + (end < body.length ? '…' : '');
  return raw.replace(/\s+/g, ' ');
}

/**
 * Grep-style search over the bundled pack: no network, no embeddings, deterministic.
 * Scoring: term in doc title 4×, in section heading 3×, per body occurrence 1× (capped at 5),
 * +3 whole-phrase bonus, +2 when every term matched somewhere in the section.
 */
export function searchKnowledge(
  query: string,
  opts: { topic?: string; limit?: number } = {},
): { results: KnowledgeSearchResult[]; hint?: string } {
  const limit = Math.min(Math.max(1, opts.limit ?? 5), 10);
  const phrase = String(query ?? '').trim().toLowerCase();
  const terms = phrase.split(/[^a-z0-9_$@.-]+/i).filter((t) => t.length >= 3);
  if (!phrase || (!terms.length && phrase.length < 3)) {
    return { results: [], hint: `empty query — topics: ${Object.keys(KNOWLEDGE).join(', ')}` };
  }

  const candidates = index().filter((s) => !opts.topic || s.topic === opts.topic);
  const scored: Array<{ s: Section; score: number; anchor: number; anchorTerm: string }> = [];

  for (const s of candidates) {
    let score = 0;
    let matchedTerms = 0;
    let anchor = -1;
    let anchorTerm = terms[0] ?? phrase;
    for (const term of terms) {
      const inTitle = s.titleLower.includes(term);
      const inHeading = s.headingLower.includes(term);
      const bodyHits = countOccurrences(s.bodyLower, term, 5);
      if (inTitle) score += 4;
      if (inHeading) score += 3;
      score += bodyHits;
      if (inTitle || inHeading || bodyHits > 0) matchedTerms++;
      if (anchor === -1 && bodyHits > 0) {
        anchor = s.bodyLower.indexOf(term);
        anchorTerm = term;
      }
    }
    const phraseAt = terms.length > 1 ? s.bodyLower.indexOf(phrase) : -1;
    if (phraseAt !== -1) {
      score += 3;
      anchor = phraseAt;
      anchorTerm = phrase;
    }
    if (terms.length > 1 && matchedTerms === terms.length) score += 2;
    if (score > 0) {
      scored.push({ s, score, anchor: anchor === -1 ? 0 : anchor, anchorTerm });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const results: KnowledgeSearchResult[] = [];
  const perTopic = new Map<string, number>();
  for (const { s, score, anchor, anchorTerm } of scored) {
    const used = perTopic.get(s.topic) ?? 0;
    if (used >= 2) continue; // max 2 sections per topic — diversity over depth
    perTopic.set(s.topic, used + 1);
    results.push({
      topic: s.topic,
      title: s.title,
      heading: s.heading,
      uri: `agenticnets://docs/${s.topic}`,
      score,
      excerpt: excerptAround(s.body, anchor, anchorTerm),
    });
    if (results.length >= limit) break;
  }

  if (!results.length) {
    return {
      results: [],
      hint: `no match — topics: ${Object.keys(KNOWLEDGE).join(', ')}; try broader terms or read agenticnets://docs/index`,
    };
  }
  return { results };
}
