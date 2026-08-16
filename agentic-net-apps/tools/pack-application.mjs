#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[index + 1]]);
  return all;
}, []));
if (!args.config) throw new Error('Usage: pack-application.mjs --config path/to/agenticos.app.json');

const configPath = resolve(process.cwd(), args.config);
const configDir = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
for (const field of ['name', 'version', 'displayName', 'runtimePackage', 'ui', 'application']) {
  if (!config[field]) throw new Error(`agenticos.app.json requires ${field}`);
}
if (!/^[a-z][a-z0-9._-]*-[a-z0-9._-]+$/.test(config.ui.element || '')) {
  throw new Error('ui.element must be a valid lowercase custom-element name containing a dash');
}
if (!/^[a-z][a-z0-9-]*$/.test(config.name)) throw new Error('name must be lowercase kebab-case');
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(config.version)) {
  throw new Error('version must be semantic version syntax such as 1.0.0');
}
if (config.application.scope !== 'model') throw new Error('application.scope must be model');
if (!['singleton', 'multiple'].includes(config.application.instancePolicy)) {
  throw new Error('application.instancePolicy must be singleton or multiple');
}
if (!Array.isArray(config.application.stores) || !config.application.stores.length) {
  throw new Error('application.stores must declare at least one semantic store role');
}
if (!Array.isArray(config.application.actions)) throw new Error('application.actions must be an array');
const permissions = config.application.permissions;
for (const capability of ['readStores', 'watchStores', 'actions']) {
  if (!Array.isArray(permissions?.[capability])) {
    throw new Error(`application.permissions.${capability} must be an explicit array`);
  }
}
if (config.ui.isolation && config.ui.isolation !== 'trusted-element') {
  throw new Error('ui.isolation currently supports only trusted-element');
}

let entryPath = resolve(configDir, config.ui.entryFile);
try { await readFile(entryPath); } catch {
  const buildDir = dirname(entryPath);
  const candidate = (await readdir(buildDir)).find(name => /^main(?:-[A-Z0-9]+)?\.js$/i.test(name));
  if (!candidate) throw new Error(`UI entry not found: ${entryPath}. Run the Angular build first.`);
  entryPath = resolve(buildDir, candidate);
}
const source = await readFile(entryPath, 'utf8');
if (/\bimport\s*(?:\(|[{'"*])/.test(source.replace(/import\.meta/g, ''))) {
  throw new Error('UI entry must be a self-contained ESM module; external/chunk imports are not allowed');
}
const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
const safe = value => String(value).replace(/[^A-Za-z0-9._-]/g, '-');
const blobId = `applications/${safe(config.name)}/${safe(config.version)}/${sha256}/main.mjs`;
const urn = `urn:agenticos:blob:${blobId}`;
const runtime = JSON.parse(await readFile(resolve(configDir, config.runtimePackage), 'utf8'));
if (runtime.kind !== 'session') throw new Error('runtimePackage must be kind=session');
if (!Array.isArray(runtime.nets) || !runtime.nets.length) throw new Error('runtimePackage must carry at least one session net');

const placeIds = new Set(runtime.nets.flatMap(entry => Object.keys(entry?.net?.net?.places || {})));
const roles = new Set();
for (const store of config.application.stores) {
  if (!store?.role || !store?.placeId) throw new Error('every application store requires role and placeId');
  if (roles.has(store.role)) throw new Error(`duplicate application store role: ${store.role}`);
  if (!placeIds.has(store.placeId)) throw new Error(`store ${store.role} references missing place ${store.placeId}`);
  roles.add(store.role);
}
const actionNames = new Set();
for (const action of config.application.actions) {
  if (!action?.name || !roles.has(action.targetRole)) {
    throw new Error(`action ${action?.name || '<unnamed>'} references unknown targetRole ${action?.targetRole}`);
  }
  if (actionNames.has(action.name)) throw new Error(`duplicate application action: ${action.name}`);
  actionNames.add(action.name);
  if (action.guard) {
    if (!roles.has(action.guard.role)) {
      throw new Error(`action ${action.name} guard references unknown role ${action.guard.role}`);
    }
    if (!action.guard.matchKey) throw new Error(`action ${action.name} guard requires matchKey`);
    if (action.guard.exists !== undefined && typeof action.guard.exists !== 'boolean') {
      throw new Error(`action ${action.name} guard.exists must be boolean`);
    }
    if (action.guard.exists === false && action.guard.role !== action.targetRole) {
      throw new Error(`action ${action.name} exists:false guard role must equal targetRole for atomic uniqueness`);
    }
    if (action.guard.compare !== undefined) {
      if (!Array.isArray(action.guard.compare) || !action.guard.compare.length) {
        throw new Error(`action ${action.name} guard.compare must be a non-empty array`);
      }
      for (const comparison of action.guard.compare) {
        const operand = value => typeof value === 'string'
          && /^\$(?:input|target)\.[A-Za-z_][A-Za-z0-9_-]*$/.test(value);
        if (!comparison || !operand(comparison.left)) {
          throw new Error(`action ${action.name} guard comparison left must be $input.<field> or $target.<field>`);
        }
        if (typeof comparison.right === 'string' && comparison.right.startsWith('$')
            && !operand(comparison.right)) {
          throw new Error(`action ${action.name} guard comparison right path is invalid`);
        }
        if (!['equals', 'notEquals', 'in', 'notIn'].includes(comparison.operator)) {
          throw new Error(`action ${action.name} guard comparison operator is invalid`);
        }
        if (!Object.hasOwn(comparison, 'right')) {
          throw new Error(`action ${action.name} guard comparison requires right`);
        }
      }
    }
  }
  for (const effect of action.effects || []) {
    if (!roles.has(effect?.updateRole)) {
      throw new Error(`action ${action.name} effect references unknown updateRole ${effect?.updateRole}`);
    }
    if (!effect.matchKey) throw new Error(`action ${action.name} effect requires matchKey`);
    if (!Object.keys(effect.set || {}).length && !Object.keys(effect.setFromInput || {}).length) {
      throw new Error(`action ${action.name} effect requires set or setFromInput`);
    }
  }
}
for (const role of [...permissions.readStores, ...permissions.watchStores]) {
  if (!roles.has(role)) throw new Error(`permissions reference undeclared store role: ${role}`);
}
for (const action of permissions.actions) {
  if (!actionNames.has(action)) throw new Error(`permissions reference undeclared action: ${action}`);
}
const agentProtocol = config.application.agentProtocol;
if (agentProtocol) {
  for (const field of ['taskStoreRole', 'activityStoreRole']) {
    if (agentProtocol[field] && !roles.has(agentProtocol[field])) {
      throw new Error(`application.agentProtocol.${field} references undeclared role: ${agentProtocol[field]}`);
    }
  }
  for (const step of agentProtocol.workflow || []) {
    if (step?.action && !actionNames.has(step.action)) {
      throw new Error(`application.agentProtocol.workflow references undeclared action: ${step.action}`);
    }
  }
}

const applicationManifest = {
  manifestVersion: '2.0',
  name: config.name,
  displayName: config.displayName,
  description: config.description,
  tags: config.tags || [],
  ...config.application,
  surface: {
    ...config.application.surface,
    type: 'web-component',
    element: config.ui.element,
    entry: urn,
    integrity: `sha256-${sha256}`,
    isolation: config.ui.isolation || 'trusted-element',
    sdkVersion: config.ui.sdkVersion || '^0.1.0',
  },
};

const pkg = {
  ...runtime,
  format: 'agentic-net-package',
  formatVersion: runtime.formatVersion || '1.5.0',
  scope: runtime.scope || 'runtime',
  kind: 'application',
  visibility: config.visibility || 'public',
  tokenPolicy: runtime.tokenPolicy || 'none',
  manifest: {
    name: config.name,
    version: config.version,
    description: config.description,
    author: config.author,
    tags: [...new Set(['application', ...(config.tags || [])])],
    createdAt: new Date().toISOString(),
    agenticosVersion: config.agenticosVersion || '1.0.0',
  },
  applicationManifest,
  blobs: [
    ...((runtime.blobs || []).filter(blob => blob.urn !== urn)),
    { urn, sha256, contentType: 'text/javascript; charset=utf-8', contentBase64: Buffer.from(source, 'utf8').toString('base64') },
  ],
  contentHash: null,
};

const output = resolve(configDir, config.output || `../../dist/packages/${config.name}-${config.version}.application.json`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
process.stdout.write(`${output}\n${Buffer.byteLength(JSON.stringify(pkg))} bytes\nsha256-${sha256}\n`);
