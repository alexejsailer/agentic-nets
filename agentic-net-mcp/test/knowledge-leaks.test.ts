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
 * Also enforces the sizing discipline (per-doc 8KB, pack 96KB, bounded instructions) so the
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
  // local headless CLI agents, model-per-domain, the protocol journal). Then
  // 70K → 72K for the servable AI-lane roster: `external` became explicit-only, so
  // the docs had to stop describing a provider-less master as auto-marking lanes and
  // start describing the servable verdict clients now steer by. Then 72K → 78K for
  // docs/real-agents — a Windows field deployment proved the flagship pattern
  // (scheduled persona nets reasoning via headless Claude Code) and its traps
  // (the stdin-pipe rule, the /bin/sh bridge) were learnable only the hard way.
  // 78K → 88K for the persona-first guide: persona/team/context/self-learning design must be
  // available to every MCP client offline instead of living only in the newcomer tray manual.
  // 88K → 96K for the Safe Product Team playbook: repository contracts, the event/status/Protocol
  // observability stack, and NetHub packaging must travel with every client that can deploy it.
  // 96K → 104K for the domain-neutral Model Steward: its evidence contract and advisory-only
  // boundary must be available to provider-backed and provider-free clients alike.
  // 104K → 112K for docs/applications: net-backed application views (Protocol/Interview/Goals)
  // are the human-input path, and a client that guesses place ids or waits for a person inside a
  // firing lease gets both wrong — the contract has to travel offline with every client.
  // 112K → 114K for the 2026-08-11 field-report semantics: missing-field ArcQL, input-scope emit
  // guards, empty-tick interpolation, parsedStdout read-vs-template, hub install lifecycle and
  // template-source id-baking — every one a measured silent-failure a client re-hits without it.
  // 114K → 118K for docs/observability: the three-layer history model (ring/journal/node
  // blocks), per-model retention config, and the absence-of-evidence rules must travel with
  // every client that now has a durable journal to read — misreading eviction as "never
  // happened" was the field reports' core failure class.
  // Per-doc 8KB discipline is unchanged — this is budget growth, not budget removal.
  // 2026-08-14: +4KB for docs/leases — the reservation mechanism became teachable after the
  // staging lease-collision incident; a doc that prevents operators deleting in-flight tokens
  // earns its bytes. Growth stays deliberate: raise this only WITH a new doc, never for edits.
  // 124K → 126K for the lease-doctrine corrections from the 2026-08-15 adversarial review:
  // the wedged-vs-slow stop caveat, the never-author-_lock rule, the read-only duplicate-
  // emission consequence, and honest version pins — each one a teachable falsehood an agent
  // would otherwise act on.
  const PACK_CAP = 129024;
  // 2026-08-14: +512B for gotcha rule 12 (leases) — a new ENGINE MECHANISM earns a rule; this
  // cap is defended per-edit (rule 12 was minimized to two lines first). Raise only WITH a new
  // rule, never for rewording.
  const INSTRUCTIONS_CAP = 17920;

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

  // The multi-model preamble is longer — this build was silently over cap while the
  // single-model assertion stayed green. Pin both.
  it(`instructions fit ${INSTRUCTIONS_CAP}B in the multi-model build too`, () => {
    const multi = { ...FAKE_CONFIG, models: ['m1', 'm2'] };
    expect(Buffer.byteLength(buildInstructions(multi), 'utf8')).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
  });
});
