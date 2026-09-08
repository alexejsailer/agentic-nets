#!/usr/bin/env node
// Fails when agenticos.app.json.version has no matching artifact or the artifact's surface
// integrity no longer matches ui/main.mjs (the drift that made the README install the wrong app).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'agenticos.app.json'), 'utf8'));
const artifact = join(here, cfg.output || `web-investigator-${cfg.version}.application.json`);
if (!existsSync(artifact)) { console.error(`missing artifact ${artifact} for version ${cfg.version}; run the packer`); process.exit(1); }
const pkg = JSON.parse(readFileSync(artifact, 'utf8'));
const want = `sha256-${createHash('sha256').update(readFileSync(join(here, cfg.ui.entryFile), 'utf8'), 'utf8').digest('hex')}`;
const got = pkg.applicationManifest?.surface?.integrity || pkg.surface?.integrity;
const version = pkg.manifest?.version;
const problems = [];
if (got !== want) problems.push(`surface.integrity ${got} != ${want} (ui changed after packing)`);
if (String(version) !== String(cfg.version)) problems.push(`artifact version ${version} != manifest ${cfg.version}`);
const actions = new Set((pkg.applicationManifest?.actions || []).map((a) => a.name));
for (const a of cfg.application.permissions.actions) if (!actions.has(a)) problems.push(`permission names unknown action ${a}`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`ok: ${cfg.name} ${cfg.version} matches ${artifact.split('/').pop()} (${got})`);
