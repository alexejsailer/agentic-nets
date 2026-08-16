#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pairs = process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all[value.slice(2)] = values[index + 1];
  return all;
}, {});
if (!pairs.file) throw new Error('Usage: publish-application.mjs --file <package.json> [--gateway http://localhost:8083]');
const pkg = JSON.parse(await readFile(resolve(process.cwd(), pairs.file), 'utf8'));
if (pkg.kind !== 'application' || !pkg.manifest?.name || !pkg.manifest?.version) {
  throw new Error('File is not a kind=application AgenticNet package');
}
const gateway = String(pairs.gateway || process.env.AGENTICOS_GATEWAY || 'http://localhost:8083').replace(/\/$/, '');
const token = pairs.token || process.env.AGENTICOS_TOKEN;
const headers = { 'content-type': 'application/json' };
if (token) headers.authorization = `Bearer ${token}`;
const url = `${gateway}/api/hub/applications/${encodeURIComponent(pkg.manifest.name)}/versions/${encodeURIComponent(pkg.manifest.version)}`;
const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(pkg) });
const body = await response.text();
if (!response.ok) throw new Error(`Publish failed (${response.status}): ${body}`);
process.stdout.write(`${pkg.manifest.name}@${pkg.manifest.version} published to ${gateway}\n`);
