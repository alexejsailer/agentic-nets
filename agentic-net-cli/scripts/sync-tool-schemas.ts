/**
 * Regenerate `src/agent/tools.generated.ts` from the master-side catalog.
 *
 * Source of truth: `core/agentic-net-master/src/main/resources/agent-tool-catalog.json`.
 *
 * Reads the JSON from one of two places, in order:
 *   1. the repo's filesystem path (preferred, works offline)
 *   2. a running master at $AGENTIC_MASTER_URL/api/agent/tools/catalog
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

async function main() {
  const catalog = await loadCatalog();
  if (!Array.isArray(catalog.tools) || catalog.tools.length === 0) {
    throw new Error('Catalog has no tools');
  }
  const source = emit(catalog);
  fs.writeFileSync(outputPath, source, 'utf-8');
  console.log(`Wrote ${catalog.tools.length} tool schema(s) to ${outputPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
