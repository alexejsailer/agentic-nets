/**
 * Regenerate `src/agent/tools.generated.ts` from the master-side catalog, and
 * sync `src/agent/capability-profiles.json` verbatim from the master's canonical
 * capability catalog.
 *
 * Sources of truth (both owned by core/agentic-net-master/src/main/resources/):
 *   - `agent-tool-catalog.json`         → tools.generated.ts (code-generated)
 *   - `agent-capability-profiles.json`  → capability-profiles.json (verbatim copy)
 *
 * Tool catalog is read from one of two places, in order:
 *   1. the repo's filesystem path (preferred, works offline)
 *   2. a running master at $AGENTIC_MASTER_URL/api/agent/tools/catalog
 * The capability catalog syncs only from the filesystem (private core checkout);
 * public checkouts keep the committed copy — both loaders assert schemaVersion.
 *
 * Run via `npm run sync-tools` from the agentic-net-cli directory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths relative to the CLI project root (one level up from scripts/).
const cliRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(cliRoot, '..', '..'); // agentic-nets/agentic-net-cli/ → AgenticOS/
const catalogFsPath = path.resolve(
  repoRoot,
  'core/agentic-net-master/src/main/resources/agent-tool-catalog.json'
);
const outputPath = path.resolve(cliRoot, 'src/agent/tools.generated.ts');
const handToolsPath = path.resolve(cliRoot, 'src/agent/tools.ts');
const capabilityCatalogFsPath = path.resolve(
  repoRoot,
  'core/agentic-net-master/src/main/resources/agent-capability-profiles.json'
);
const capabilityCatalogOutPath = path.resolve(cliRoot, 'src/agent/capability-profiles.json');

/**
 * Tools already hand-defined in tools.ts TOOL_DEFS keep their curated schemas —
 * the generated file only fills the gaps. Without this filter a full regeneration
 * duplicates every hand key (TS2783) and silently overwrites the curated entries
 * via the object spread.
 */
function handDefinedToolNames(): Set<string> {
  const src = fs.readFileSync(handToolsPath, 'utf-8');
  const names = new Set<string>();
  for (const m of src.matchAll(/^  ([A-Z][A-Z0-9_]+): \{$/gm)) {
    names.add(m[1]);
  }
  return names;
}

interface CatalogTool {
  name: string;
  description: string;
  requiredFlags?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface Catalog {
  version: number;
  description?: string;
  tools: CatalogTool[];
}

async function loadCatalog(): Promise<Catalog> {
  if (fs.existsSync(catalogFsPath)) {
    const raw = fs.readFileSync(catalogFsPath, 'utf-8');
    return JSON.parse(raw) as Catalog;
  }
  const url = process.env.AGENTIC_MASTER_URL
    ? `${process.env.AGENTIC_MASTER_URL.replace(/\/$/, '')}/api/agent/tools/catalog`
    : 'http://localhost:8082/api/agent/tools/catalog';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Cannot load catalog from filesystem (${catalogFsPath}) or master (${url}: HTTP ${res.status})`
    );
  }
  return (await res.json()) as Catalog;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function emitSchema(schema: CatalogTool['input_schema']): string {
  const props = Object.entries(schema.properties || {})
    .map(([key, val]) => {
      const v = val as Record<string, unknown>;
      const parts: string[] = [];
      if (v.type) parts.push(`type: ${quote(v.type as string)}`);
      if (v.description) parts.push(`description: ${quote(v.description as string)}`);
      return `        ${key}: { ${parts.join(', ')} }`;
    })
    .join(',\n');
  const required = (schema.required || []).map(quote).join(', ');
  return `    schema: {
      type: 'object',
      properties: {
${props}
      },
      required: [${required}],
    },`;
}

function emit(catalog: Catalog): string {
  const header = `/**
 * AUTO-GENERATED from core/agentic-net-master/src/main/resources/agent-tool-catalog.json
 *
 * Run \`npm run sync-tools\` to regenerate from the master catalog.
 * Edit the JSON file, not this TypeScript — changes here will be overwritten.
 */
import type { ToolDef } from './tools.js';

`;

  const names = catalog.tools.map(t => `  | ${quote(t.name)}`).join('\n');
  const unionBlock = `type GeneratedToolName =
${names};

`;

  const entries = catalog.tools
    .map(t => `  ${t.name}: {
    description: ${quote(t.description)},
${emitSchema(t.input_schema)}
  },`)
    .join('\n');

  const exportBlock = `export const GENERATED_TOOL_DEFINITIONS: Record<GeneratedToolName, ToolDef> = {
${entries}
};
`;

  return header + unionBlock + exportBlock;
}

/** Verbatim copy — the CLI's capability semantics must be byte-identical to master's. */
function syncCapabilityCatalog(): void {
  if (!fs.existsSync(capabilityCatalogFsPath)) {
    console.log('Capability catalog source not present (public checkout) — keeping committed copy');
    return;
  }
  const source = fs.readFileSync(capabilityCatalogFsPath, 'utf-8');
  const parsed = JSON.parse(source) as { schemaVersion?: string };
  if (!parsed.schemaVersion) {
    throw new Error(`Capability catalog at ${capabilityCatalogFsPath} has no schemaVersion`);
  }
  fs.writeFileSync(capabilityCatalogOutPath, source, 'utf-8');
  console.log(`Synced capability catalog (schemaVersion ${parsed.schemaVersion}) to ${capabilityCatalogOutPath}`);
}

async function main() {
  syncCapabilityCatalog();
  const catalog = await loadCatalog();
  if (!Array.isArray(catalog.tools) || catalog.tools.length === 0) {
    throw new Error('Catalog has no tools');
  }
  const hand = handDefinedToolNames();
  const skipped = catalog.tools.filter(t => hand.has(t.name)).length;
  catalog.tools = catalog.tools.filter(t => !hand.has(t.name));
  if (skipped > 0) {
    console.log(`Skipped ${skipped} tool(s) already hand-defined in tools.ts`);
  }
  const source = emit(catalog);
  fs.writeFileSync(outputPath, source, 'utf-8');
  console.log(`Wrote ${catalog.tools.length} tool schema(s) to ${outputPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
