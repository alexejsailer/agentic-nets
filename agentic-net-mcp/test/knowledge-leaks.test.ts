import { describe, expect, it } from 'vitest';
import { KNOWLEDGE } from '../src/knowledge/index.js';
import { buildInstructions } from '../src/instructions.js';
import { TEMPLATES } from '../src/templates/index.js';

/**
 * THE LEAK GATE — the enforcement half of the knowledge pack's security posture.
 *
 * The pack is curated from sources that demonstrably contain credentials-adjacent content
 * (private CLAUDE.md files carry staging IPs, personal paths, CI internals). Curation is a
 * human process; this test is the machine check that nothing forbidden ever ships in ANY
 * string the MCP serves: knowledge docs, initialize-time instructions, and template blueprints.
 *
 * Also enforces the sizing discipline (per-doc 8KB, pack 64KB, instructions 15KB) so the
 * teaching layer stays cheap to read and can't silently bloat.
 */

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  // Infrastructure / topology (versions like 2.27.0 have only 3 parts and don't match)
  { name: 'IPv4 address', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'privileged user@host', re: /\b(root|admin|deploy)@[\w.-]+/i },
  { name: 'host filesystem path', re: /\/(Users|home)\/[a-zA-Z]/ },
  { name: 'infra install path', re: /\/opt\/agenticos/i },
  { name: 'CI infrastructure', re: /jenkins/i },
  { name: 'internal jenkins port', re: /localhost:9080/ },
  { name: 'staging/production hostname', re: /agentic-nets\.com|\bstaging\.[\w-]+\.\w{2,}/i },
  { name: 'internal corporate domain', re: /\b[\w.-]+\.company\.com\b/ },
  // Credentials
  { name: 'userinfo in URL (user:pass@)', re: /\/\/[^\s"'/]+:[^\s"'@/]+@/ },
  { name: 'long hex (secret-like)', re: /\b[0-9a-f]{32,}\b/i },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'Google OAuth token', re: /\bya29\./ },
  {
    name: 'API key prefix',
    re: /\b(sk-ant-[A-Za-z0-9]|sk-proj-[A-Za-z0-9]|ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|glpat-[A-Za-z0-9]|xox[bap]-[A-Za-z0-9]|AKIA[0-9A-Z]{16})/,
  },
  { name: 'secret env var WITH VALUE', re: /AGENTICOS_[A-Z_]*(SECRET|TOKEN|KEY)\s*[=:]\s*['"]?[A-Za-z0-9+/_-]{8,}/ },
  { name: 'private key block', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  // `Bearer ${credentials.X}` (the documented pattern) stays legal; a literal token does not.
  { name: 'literal bearer token', re: /Bearer\s+(?!\$\{)[A-Za-z0-9._-]{20,}/ },
  { name: 'personal email', re: /\b[\w.+-]+@(gmail|proton|protonmail|outlook|gmx|web)\.\w+/i },
];

function violations(text: string): string[] {
  const hits: string[] = [];
  const lines = text.split('\n');
  for (const { name, re } of FORBIDDEN) {
    lines.forEach((line, i) => {
      const m = line.match(re);
      if (m) hits.push(`line ${i + 1} [${name}]: …${line.trim().slice(0, 120)}…  (matched: ${m[0].slice(0, 60)})`);
    });
  }
  return hits;
}

const FAKE_CONFIG: any = { models: ['m1'], mode: 'rw', session: 'test', allowModelCreate: false };

describe('leak gate — nothing credential/infra-shaped ships', () => {
  for (const [topic, doc] of Object.entries(KNOWLEDGE)) {
    it(`knowledge doc '${topic}' is clean`, () => {
      const hits = violations(doc.text);
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }

  it('initialize-time instructions are clean', () => {
    const hits = violations(buildInstructions(FAKE_CONFIG));
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('template blueprints are clean', () => {
    for (const [id, blueprint] of Object.entries(TEMPLATES)) {
      const hits = violations(JSON.stringify(blueprint, null, 1));
      expect(hits, `${id}:\n${hits.join('\n')}`).toEqual([]);
    }
  });
});

describe('sizing discipline — the teaching layer stays cheap', () => {
  const PER_DOC_CAP = 8192;
  // Raised 64K → 70K for the Desktop-Lite guidance wave (external-fire duty,
  // local headless CLI agents, model-per-domain, the protocol journal). Per-doc
  // 8KB discipline is unchanged — this is budget growth, not budget removal.
  const PACK_CAP = 71680;
  const INSTRUCTIONS_CAP = 15360;

  for (const [topic, doc] of Object.entries(KNOWLEDGE)) {
    it(`doc '${topic}' fits the ${PER_DOC_CAP}B cap and is well-formed`, () => {
      expect(Buffer.byteLength(doc.text, 'utf8'), `${topic} exceeds the per-doc cap — split it`).toBeLessThanOrEqual(PER_DOC_CAP);
      expect(topic).toMatch(/^[a-z-]+$/);
      expect(doc.text.trimStart().startsWith('# '), `${topic} must start with a single '# Title' line`).toBe(true);
      expect(doc.title.length).toBeGreaterThan(0);
    });
  }

  it(`whole pack fits ${PACK_CAP}B`, () => {
    const total = Object.values(KNOWLEDGE).reduce((n, d) => n + Buffer.byteLength(d.text, 'utf8'), 0);
    expect(total).toBeLessThanOrEqual(PACK_CAP);
  });

  it(`instructions fit ${INSTRUCTIONS_CAP}B`, () => {
    expect(Buffer.byteLength(buildInstructions(FAKE_CONFIG), 'utf8')).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
  });
});
