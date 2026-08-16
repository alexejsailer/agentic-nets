#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[index + 1]]);
  return all;
}, []));
if (!args.config || !args.file) {
  throw new Error('Usage: test-application-package.mjs --config agenticos.app.json --file package.application.json');
}

const configPath = resolve(process.cwd(), args.config);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const pkg = JSON.parse(await readFile(resolve(process.cwd(), args.file), 'utf8'));

assert.equal(pkg.kind, 'application');
assert.equal(pkg.manifest.name, config.name);
assert.equal(pkg.manifest.version, config.version);
assert.equal(pkg.applicationManifest.manifestVersion, '2.0');
assert.equal(pkg.applicationManifest.surface.type, 'web-component');
assert.equal(pkg.applicationManifest.surface.element, config.ui.element);
assert.deepEqual(pkg.applicationManifest.permissions, config.application.permissions);
assert.deepEqual(pkg.applicationManifest.agentProtocol, config.application.agentProtocol);
assert.ok(Array.isArray(pkg.nets) && pkg.nets.length > 0, 'package carries a runtime net');

const places = new Set(pkg.nets.flatMap(entry => Object.keys(entry?.net?.net?.places || {})));
for (const store of pkg.applicationManifest.stores) {
  assert.ok(places.has(store.placeId), `store ${store.role} maps to runtime place ${store.placeId}`);
}

const actionNames = new Set(pkg.applicationManifest.actions.map(action => action.name));
for (const action of pkg.applicationManifest.permissions.actions) {
  assert.ok(actionNames.has(action), `permission action ${action} is declared`);
}
for (const step of pkg.applicationManifest.agentProtocol?.workflow || []) {
  assert.ok(actionNames.has(step.action), `agent workflow action ${step.action} is declared`);
}

const entryUrn = pkg.applicationManifest.surface.entry;
const blob = pkg.blobs.find(candidate => candidate.urn === entryUrn);
assert.ok(blob, 'surface entry blob is embedded');
const source = Buffer.from(blob.contentBase64, 'base64');
const sha256 = createHash('sha256').update(source).digest('hex');
assert.equal(blob.sha256, sha256);
assert.equal(pkg.applicationManifest.surface.integrity, `sha256-${sha256}`);
assert.ok(source.length > 0 && source.length < 1024 * 1024, 'UI module is non-empty and below 1 MiB');
assert.doesNotMatch(source.toString('utf8').replace(/import\.meta/g, ''), /\bimport\s*(?:\(|[{\'"*])/,
  'UI entry is a self-contained ESM module');

const runtimePath = resolve(dirname(configPath), config.runtimePackage);
const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
assert.equal(runtime.kind, 'session');
assert.equal(runtime.tokenPolicy || 'none', pkg.tokenPolicy);

process.stdout.write(`ok ${config.name}@${config.version}: ${actionNames.size} actions, ${places.size} places, ${source.length} UI bytes, sha256-${sha256}\n`);
