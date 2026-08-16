#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[index + 1]]);
  return all;
}, []));
if (!args.name || !args.version || !args.output) {
  throw new Error('Usage: pull-runtime.mjs --name <artifact> --version <version> --output <session.package.json>');
}

const gateway = String(args.gateway || process.env.AGENTICOS_GATEWAY || 'http://localhost:8083').replace(/\/$/, '');
const token = args.token || process.env.AGENTICOS_TOKEN;
const headers = token ? { authorization: `Bearer ${token}` } : {};
const url = `${gateway}/api/hub/artifacts/${encodeURIComponent(args.name)}/versions/${encodeURIComponent(args.version)}`;
const response = await fetch(url, { headers });
const body = await response.text();
if (!response.ok) throw new Error(`Runtime download failed (${response.status}): ${body}`);

const pkg = JSON.parse(body);
if (pkg.kind !== 'session' || !Array.isArray(pkg.nets) || !pkg.nets.length) {
  throw new Error(`${args.name}@${args.version} is not a session bundle with nets`);
}
const output = resolve(process.cwd(), args.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
process.stdout.write(`${args.name}@${args.version} -> ${output}\n`);
