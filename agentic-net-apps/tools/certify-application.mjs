#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[index + 1] || 'true']);
  return all;
}, []));
if (!args.scenario) {
  throw new Error('Usage: certify-application.mjs --scenario path/to/certification.json [--gateway http://127.0.0.1:8083] [--token JWT] [--keep-model]');
}

const scenarioPath = resolve(process.cwd(), args.scenario);
const scenarioDir = dirname(scenarioPath);
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
const gateway = String(args.gateway || process.env.AGENTICOS_GATEWAY || 'http://127.0.0.1:8083').replace(/\/$/, '');
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const model = `${scenario.modelPrefix || 'app-cert'}-${runId}`;
const session = scenario.sessionId || `application-${scenario.name}`;
const keepModel = args['keep-model'] === 'true';
const checks = [];
let token = args.token || process.env.AGENTICOS_TOKEN || '';
let createdModel = false;
let failure;

function check(name, detail = '') {
  checks.push({ name, passed: true, detail });
  process.stdout.write(`✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function property(object, path) {
  return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}

function matches(properties, expected = {}) {
  return Object.entries(expected).every(([path, wanted]) => {
    const actual = property(properties, path);
    return Array.isArray(wanted) ? wanted.some(value => String(value) === String(actual))
      : String(actual) === String(wanted);
  });
}

async function obtainToken() {
  if (token) return;
  const secretFile = resolve(args['admin-secret-file'] || `${homedir()}/.agenticos/desktop/gateway/jwt/admin-secret`);
  try { await access(secretFile); } catch {
    throw new Error(`No AGENTICOS_TOKEN and Desktop admin secret was not found at ${secretFile}`);
  }
  const secret = (await readFile(secretFile, 'utf8')).trim();
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: 'agenticos-admin', client_secret: secret,
  });
  const response = await fetch(`${gateway}/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) throw new Error(`Admin token exchange failed (${response.status})`);
  token = json.access_token;
}

async function waitForGateway(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${gateway}/actuator/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.cause?.code || error.message;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`Gateway did not become ready within ${timeoutMs / 1000}s (${lastError})`);
}

async function api(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* Asset or plain error body. */ }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

function expectStatus(result, expected, context) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(allowed.includes(result.status),
    `${context}: expected HTTP ${allowed.join('|')}, got ${result.status}: ${result.text}`);
}

async function staticPackageCheck(version) {
  const file = resolve(scenarioDir, version.file);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(pkg.kind, 'application');
  assert.equal(pkg.manifest.name, scenario.name);
  assert.equal(pkg.manifest.version, version.version);
  const surface = pkg.applicationManifest?.surface;
  const blob = pkg.blobs?.find(candidate => candidate.urn === surface?.entry);
  assert.ok(blob, `${version.version}: entry blob is embedded`);
  const source = Buffer.from(blob.contentBase64, 'base64');
  const hash = createHash('sha256').update(source).digest('hex');
  assert.equal(blob.sha256, hash);
  assert.equal(surface.integrity, `sha256-${hash}`);
  assert.doesNotMatch(source.toString('utf8').replace(/import\.meta/g, ''), /\bimport\s*(?:\(|[{'"*])/);
  return { file, pkg, hash, bytes: source.length };
}

async function publishVersions() {
  for (const version of scenario.versions) {
    const checked = await staticPackageCheck(version);
    const result = await api('PUT', `/api/hub/applications/${encodeURIComponent(scenario.name)}/versions/${encodeURIComponent(version.version)}`, checked.pkg);
    expectStatus(result, 200, `publish ${version.version}`);
    check(`package ${version.version}`, `${checked.bytes} UI bytes, sha256-${checked.hash}`);
  }
}

async function quiesceModel() {
  const listed = await api('GET', `/api/runtime/transitions?modelId=${encodeURIComponent(model)}`);
  expectStatus(listed, 200, 'list clean-room transitions');
  const transitions = listed.body?.transitions || [];
  const active = transitions.filter(transition =>
    !['stopped', 'undeployed'].includes(String(transition.status || '').toLowerCase()));
  for (const transition of active) {
    const stopped = await api('POST',
      `/api/runtime/transitions/${encodeURIComponent(transition.transitionId)}/stop?modelId=${encodeURIComponent(model)}`);
    expectStatus(stopped, 200, `stop clean-room transition ${transition.transitionId}`);
  }
  check('quiescent clean-room model', `${active.length} background transition(s) stopped`);
}

async function install(version) {
  const result = await api('POST', '/api/hub/install', {
    source: 'local', name: scenario.name, version, targetModelId: model, targetSessionId: session,
  });
  expectStatus(result, [200, 201], `install ${version}`);
  check(`install ${version}`, `${model}/${session}`);
}

async function descriptor(step) {
  const result = await api('GET', `/api/applications/${model}/${session}`);
  expectStatus(result, 200, `describe ${step.version}`);
  const roles = (result.body.stores || []).map(store => store.role).sort();
  const actions = (result.body.actions || []).map(action => action.name).sort();
  assert.deepEqual(roles, [...step.stores].sort(), `descriptor store roles for ${step.version}`);
  assert.deepEqual(actions, [...step.actions].sort(), `descriptor actions for ${step.version}`);
  assert.equal(String(result.body.version || result.body.installedFrom?.version), step.version);
  assert.ok(result.body.agentProtocol?.rules?.length, 'agentProtocol rules are discoverable');
  check(`descriptor ${step.version}`, `${roles.length} stores, ${actions.length} actions, Persona protocol visible`);
  return result.body;
}

function actionPath(action) {
  return `/api/applications/${model}/${session}/actions/${encodeURIComponent(action)}`;
}

async function action(step) {
  const result = await api('POST', actionPath(step.action), step.input,
    step.key ? { 'Idempotency-Key': step.key } : {});
  expectStatus(result, step.expectStatus || 200, step.label || step.action);
  if (step.body) assert.ok(matches(result.body, step.body), `${step.label || step.action}: response mismatch`);
  if (step.errorContains) assert.match(String(result.body?.error || result.text), new RegExp(step.errorContains));
  check(step.label || `action ${step.action}`, `HTTP ${result.status}${result.body?.replayed ? ', replayed' : ''}`);
  return result;
}

async function parallel(step) {
  const results = await Promise.all(step.calls.map(call => api('POST', actionPath(call.action), call.input,
    call.key ? { 'Idempotency-Key': call.key } : {})));
  const successful = results.filter(result => result.status === 200).length;
  assert.equal(successful, step.successes, `${step.label}: expected ${step.successes} success`);
  for (const result of results.filter(candidate => candidate.status !== 200)) {
    expectStatus(result, step.allowedFailures, step.label);
  }
  check(step.label, `statuses ${results.map(result => result.status).join('/')}`);
}

async function readStore(step) {
  const result = await api('GET', `/api/applications/${model}/${session}/stores/${encodeURIComponent(step.role)}/tokens`);
  expectStatus(result, 200, `read ${step.role}`);
  const selected = (result.body.tokens || []).filter(token => matches(token.properties || {}, step.where));
  assert.equal(selected.length, step.count, `${step.label}: selected token count`);
  if (step.properties) {
    assert.ok(selected.every(token => matches(token.properties || {}, step.properties)),
      `${step.label}: selected token properties mismatch`);
  }
  check(step.label || `store ${step.role}`, `${selected.length} matching token(s)`);
  return selected;
}

async function readHistory(step) {
  const query = new URLSearchParams({
    limit: String(step.limit || 100),
    includeEvents: 'true',
  });
  for (const key of ['q', 'eventType', 'elementId', 'parentId', 'transactionId',
    'correlationId', 'causationId', 'sessionId', 'workspaceNetId', 'transitionId', 'fireId']) {
    if (step[key] != null) query.set(key, String(step[key]));
  }
  const result = await api('GET', `/api/models/${model}/event-history?${query}`);
  expectStatus(result, 200, step.label || 'read durable model history');
  const blocks = result.body?.blocks || [];
  assert.equal(blocks.length, step.count, `${step.label}: matching event block count`);
  if (step.source) {
    assert.equal(result.body?.historySource, step.source,
      `${step.label}: unexpected event-history source`);
  }
  if (step.transactionIdsPerBlock != null) {
    assert.ok(blocks.every(block => (block.transactionIds || []).length === step.transactionIdsPerBlock),
      `${step.label}: event block transaction count mismatch`);
  }
  const events = blocks.flatMap(block => block.events || []);
  if (step.eventCounts) {
    const actual = events.reduce((counts, event) => {
      const type = String(event.eventType || 'unknown');
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {});
    for (const [type, count] of Object.entries(step.eventCounts)) {
      assert.equal(actual[type] || 0, count, `${step.label}: ${type} count`);
    }
  }
  for (const expected of step.events || []) {
    assert.ok(events.some(event => matches(event, expected)),
      `${step.label}: no committed event matched ${JSON.stringify(expected)}`);
  }
  check(step.label || 'durable model history',
    `${blocks.length} block(s), ${events.length} event(s), ${result.body?.historySource || 'unknown source'}`);
  return blocks;
}

async function verifyAsset(step) {
  const app = await descriptor(step.descriptor);
  const result = await api('GET', app.surface.entryUrl);
  expectStatus(result, 200, `asset ${step.descriptor.version}`);
  const hash = createHash('sha256').update(result.text).digest('hex');
  assert.equal(`sha256-${hash}`, app.surface.integrity);
  assert.equal(result.headers.get('x-agentic-app-integrity'), app.surface.integrity);
  check(`asset ${step.descriptor.version}`, `browser-delivered sha256-${hash}`);
}

/**
 * Forward one action to the real gateway, wait for its full committed response, then destroy the
 * caller-facing socket. This deterministically models "server committed, client saw disconnect".
 */
async function dropResponseAfterCommit(step) {
  let settleUpstream;
  const upstreamDone = new Promise((resolvePromise, rejectPromise) => {
    settleUpstream = { resolve: resolvePromise, reject: rejectPromise };
  });
  const body = JSON.stringify(step.input);
  const target = new URL(`${gateway}${actionPath(step.action)}`);
  const server = createServer((_incoming, outgoing) => {
    const upstream = httpRequest(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'Idempotency-Key': step.key,
      },
    }, response => {
      response.resume();
      response.on('end', () => {
        settleUpstream.resolve(response.statusCode || 0);
        outgoing.destroy();
      });
    });
    upstream.on('error', settleUpstream.reject);
    upstream.end(body);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let callerSawDisconnect = false;
  try {
    await fetch(`http://127.0.0.1:${address.port}/drop`, { method: 'POST', body: '{}' });
  } catch {
    callerSawDisconnect = true;
  }
  const upstreamStatus = await upstreamDone;
  await new Promise(resolvePromise => server.close(resolvePromise));
  assert.equal(upstreamStatus, 200, `${step.label}: upstream action did not commit`);
  assert.equal(callerSawDisconnect, true, `${step.label}: failure injector did not hide the response`);
  check(`${step.label} response loss`, 'server committed; caller observed disconnect');

  const replay = await api('POST', actionPath(step.action), step.input, { 'Idempotency-Key': step.key });
  expectStatus(replay, 200, `${step.label} retry`);
  assert.equal(replay.body?.replayed, true, `${step.label}: retry was not identified as replay`);
  check(`${step.label} retry`, 'replayed=true');
}

async function runStep(step) {
  switch (step.type) {
    case 'install': return install(step.version);
    case 'descriptor': return descriptor(step);
    case 'asset': return verifyAsset(step);
    case 'action': return action(step);
    case 'parallel': return parallel(step);
    case 'store': return readStore(step);
    case 'history': return readHistory(step);
    case 'drop-response-action': return dropResponseAfterCommit(step);
    case 'list': {
      const result = await api('GET', `/api/applications/${model}`);
      expectStatus(result, 200, step.label || 'list applications');
      assert.equal((result.body || []).filter(app => app.name === scenario.name).length, 1);
      check(step.label || 'application discovery', 'exactly one singleton installation');
      return;
    }
    default: throw new Error(`Unknown certification step type: ${step.type}`);
  }
}

const startedAt = new Date().toISOString();
try {
  await waitForGateway();
  await obtainToken();
  const health = await api('GET', '/api/hub/health');
  expectStatus(health, 200, 'gateway/hub health');
  check('gateway/hub health', gateway);
  await publishVersions();
  const create = await api('POST', '/api/admin/models', {
    modelId: model, name: `${scenario.displayName || scenario.name} certification`,
    description: 'Disposable clean-room application certification model', profile: 'standard',
  });
  expectStatus(create, [200, 201], 'create clean-room model');
  createdModel = true;
  check('clean-room model', model);
  // Model creation deliberately installs a domain-maintainer. Certification tests application
  // behavior, not an unrelated LLM, so stop every active lane before adding fixture state.
  await quiesceModel();
  for (const step of scenario.steps) await runStep(step);
} catch (error) {
  failure = error;
  checks.push({ name: 'certification', passed: false, detail: error.stack || error.message || String(error) });
} finally {
  if (createdModel && !keepModel) {
    try {
      const removed = await api('DELETE', `/api/admin/models/${model}`);
      expectStatus(removed, [200, 204], 'delete disposable certification model');
      check('clean-room cleanup', model);
    } catch (cleanupError) {
      checks.push({ name: 'clean-room cleanup', passed: false, detail: cleanupError.message });
      if (!failure) failure = cleanupError;
    }
  }
  const report = {
    schemaVersion: '1.0', scenario: scenario.name, gateway, model, keptModel: createdModel && keepModel,
    startedAt, finishedAt: new Date().toISOString(), passed: !failure, checks,
  };
  const reportPath = resolve(scenarioDir, scenario.report || `../../dist/certification/${scenario.name}-${runId}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nCertification report: ${reportPath}\n`);
}

if (failure) throw failure;
process.stdout.write(`\nPASS ${scenario.name}: ${checks.length} certification checks\n`);
