#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[index + 1] || 'true']);
  return all;
}, []));
if (!args.scenario || !args.model) {
  throw new Error('Usage: certify-studio-mount.mjs --scenario path/to/certification.json --model <disposableModelId> [--headed] [--cleanup-model]');
}

const scenarioPath = resolve(process.cwd(), args.scenario);
const scenarioDir = dirname(scenarioPath);
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
const studioGate = scenario.studio;
assert.ok(studioGate?.application && studioGate?.element,
  'scenario.studio must declare application and element');
const model = String(args.model);
const studio = String(args.studio || 'http://127.0.0.1:4200').replace(/\/$/, '');
const gateway = String(args.gateway || process.env.AGENTICOS_GATEWAY || 'http://127.0.0.1:8083').replace(/\/$/, '');
const cleanupModel = args['cleanup-model'] === 'true';
const checks = [];
const browserErrors = [];
let token = process.env.AGENTICOS_TOKEN || '';
let tokenExpiresIn = 300;
let browser;
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

function requireLoopback(raw, label) {
  const url = new URL(raw);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname),
    `${label} must be loopback for secret-file certification: ${url.origin}`);
  return url.origin;
}

async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.cause?.code || error.message;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1000}s (${lastError})`);
}

async function obtainToken() {
  if (token) return;
  requireLoopback(gateway, 'gateway');
  const secretFile = resolve(args['admin-secret-file'] || `${homedir()}/.agenticos/desktop/gateway/jwt/admin-secret`);
  await access(secretFile);
  const secret = (await readFile(secretFile, 'utf8')).trim();
  const response = await fetch(`${gateway}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: 'agenticos-admin', client_secret: secret,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Admin token exchange failed (${response.status})`);
  token = body.access_token;
  tokenExpiresIn = Number(body.expires_in || tokenExpiresIn);
}

async function api(method, path) {
  const response = await fetch(`${gateway}${path}`, {
    method, headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const startedAt = new Date().toISOString();
let screenshot;
let mountedSummary;

function interactionLocator(page, interaction) {
  const exact = interaction.exact !== false;
  if (interaction.role) {
    assert.ok(interaction.name != null,
      `studio interaction using role '${interaction.role}' must declare name`);
    return page.getByRole(interaction.role, { name: interaction.name, exact });
  }
  if (interaction.label) return page.getByLabel(interaction.label, { exact });
  if (interaction.placeholder) return page.getByPlaceholder(interaction.placeholder, { exact });
  if (interaction.text) return page.getByText(interaction.text, { exact });
  if (interaction.testId) return page.getByTestId(interaction.testId);
  if (interaction.css) return page.locator(interaction.css);
  throw new Error(`studio interaction '${interaction.type}' has no locator`);
}

async function runInteraction(page, interaction) {
  const locator = interactionLocator(page, interaction).first();
  await locator.waitFor({ state: 'visible', timeout: interaction.timeoutMs || 15_000 });
  switch (interaction.type) {
    case 'click':
      await locator.click();
      break;
    case 'fill':
      assert.ok(interaction.value != null, 'fill interaction must declare value');
      await locator.fill(String(interaction.value));
      break;
    case 'select':
      assert.ok(interaction.value != null, 'select interaction must declare value');
      await locator.selectOption(interaction.value);
      break;
    case 'check':
      await locator.check();
      break;
    case 'press':
      assert.ok(interaction.key, 'press interaction must declare key');
      await locator.press(interaction.key);
      break;
    default:
      throw new Error(`unsupported studio interaction type '${interaction.type}'`);
  }
}

async function waitForSemanticStore(gate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  let selected = [];
  while (Date.now() < deadline) {
    const result = await api('GET', `/api/applications/${encodeURIComponent(model)}`
      + `/${encodeURIComponent(studioGate.application)}/stores/${encodeURIComponent(gate.role)}/tokens`);
    rows = result?.tokens || [];
    selected = rows.filter(row => matches(row.properties || {}, gate.where));
    const propertiesMatch = !gate.properties
      || selected.every(row => matches(row.properties || {}, gate.properties));
    if (selected.length === gate.count && propertiesMatch) return selected;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  assert.equal(selected.length, gate.count,
    `${gate.label || gate.role}: selected token count after ${timeoutMs}ms`);
  assert.ok(!gate.properties || selected.every(row => matches(row.properties || {}, gate.properties)),
    `${gate.label || gate.role}: properties mismatch after ${timeoutMs}ms`);
  return selected;
}

try {
  requireLoopback(studio, 'Studio');
  await Promise.all([
    waitFor(`${gateway}/actuator/health`, 'gateway'),
    waitFor(studio, 'Studio'),
  ]);
  await obtainToken();
  check('Desktop services ready', `${studio} + ${gateway}`);

  browser = await chromium.launch({ headless: args.headed !== 'true' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ jwt, expiry, modelId, studioOrigin, gatewayOrigin }) => {
    localStorage.setItem('agenticos_jwt', jwt);
    localStorage.setItem('agenticos_jwt_expiry', String(expiry));
    localStorage.setItem('agenticos_auth_app_origin', studioOrigin);
    localStorage.setItem('agenticos_auth_gateway_origin', gatewayOrigin);
    localStorage.setItem('agenticnet.applicationModelId', modelId);
    localStorage.setItem('agenticnet.applicationLastModelId', modelId);
  }, {
    jwt: token,
    expiry: Date.now() + tokenExpiresIn * 1000,
    modelId: model,
    studioOrigin: new URL(studio).origin,
    gatewayOrigin: new URL(gateway).origin,
  });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  const url = `${studio}/#/applications/${encodeURIComponent(studioGate.application)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const element = page.locator(studioGate.element);
  await element.waitFor({ state: 'visible', timeout: 30_000 });
  check('Studio mounted declared custom element', `<${studioGate.element}>`);

  mountedSummary = await element.evaluate(node => {
    const ownKeys = Object.keys(node);
    const bounds = node.getBoundingClientRect();
    const documentElement = node.ownerDocument.documentElement;
    const surface = node.firstElementChild;
    return {
      tagName: node.tagName.toLowerCase(),
      runtimeHandleExposed: 'runtime' in node,
      rawPlaceHandleExposed: ownKeys.some(key => /place.?id/i.test(key)),
      layout: {
        hostClientWidth: node.clientWidth,
        hostScrollWidth: node.scrollWidth,
        hostRight: Math.round(bounds.right),
        documentClientWidth: documentElement.clientWidth,
        documentScrollWidth: documentElement.scrollWidth,
        surfaceClientWidth: surface?.clientWidth || 0,
        surfaceScrollWidth: surface?.scrollWidth || 0,
      },
    };
  });
  assert.equal(mountedSummary.runtimeHandleExposed, false,
    'Angular custom element retained a public runtime capability handle');
  assert.equal(mountedSummary.rawPlaceHandleExposed, false,
    'Angular custom element exposed a raw place handle');
  check('runtime capability remains encapsulated', 'no runtime or raw-place handle on the DOM element');
  assert.ok(mountedSummary.layout.hostScrollWidth <= mountedSummary.layout.hostClientWidth + 1,
    `application host overflows horizontally: ${JSON.stringify(mountedSummary.layout)}`);
  assert.ok(mountedSummary.layout.surfaceScrollWidth <= mountedSummary.layout.surfaceClientWidth + 1,
    `application surface overflows horizontally: ${JSON.stringify(mountedSummary.layout)}`);
  assert.ok(mountedSummary.layout.documentScrollWidth <= mountedSummary.layout.documentClientWidth + 1,
    `Studio route overflows horizontally: ${JSON.stringify(mountedSummary.layout)}`);
  assert.ok(mountedSummary.layout.hostRight <= mountedSummary.layout.documentClientWidth + 1,
    `application host is clipped by the Studio viewport: ${JSON.stringify(mountedSummary.layout)}`);
  check('mounted layout fits Studio host', `${mountedSummary.layout.hostClientWidth}px without horizontal clipping`);

  for (const text of studioGate.text || []) {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 });
  }
  if (studioGate.text?.length) check('installed net state rendered', studioGate.text.join(', '));

  for (const interaction of studioGate.interactions || []) {
    await runInteraction(page, interaction);
  }
  if (studioGate.interactions?.length) {
    check('application UI interaction completed', `${studioGate.interactions.length} browser step(s)`);
  }

  if (studioGate.verifyStore) {
    const selected = await waitForSemanticStore(studioGate.verifyStore,
      studioGate.verifyStore.timeoutMs || 20_000);
    check(studioGate.verifyStore.label || 'semantic API re-read canonical state',
      `${selected.length} matching token(s)`);
  }

  for (const text of studioGate.textAfterAction || []) {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 });
  }
  if (studioGate.textAfterAction?.length) {
    check('mounted UI refreshed after action', studioGate.textAfterAction.join(', '));
  }
  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join(' | ')}`);
  check('browser console clean', 'no page or console errors');

  const screenshotPath = resolve(scenarioDir,
    studioGate.screenshot || `../../dist/certification/${scenario.name}-studio.png`);
  await mkdir(dirname(screenshotPath), { recursive: true });
  const bytes = await page.screenshot({ path: screenshotPath, fullPage: true });
  screenshot = {
    path: screenshotPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  check('Studio evidence captured', `${bytes.length} bytes, sha256-${screenshot.sha256}`);
} catch (error) {
  failure = error;
  checks.push({ name: 'Studio certification', passed: false, detail: error.stack || error.message || String(error) });
} finally {
  if (browser) await browser.close();
  if (cleanupModel) {
    try {
      assert.ok(model.startsWith(`${scenario.modelPrefix || 'app-cert'}-`),
        `refusing cleanup: ${model} does not have disposable prefix ${scenario.modelPrefix || 'app-cert'}-`);
      await obtainToken();
      await api('DELETE', `/api/admin/models/${encodeURIComponent(model)}`);
      check('visual-test model cleanup', model);
    } catch (cleanupError) {
      checks.push({ name: 'visual-test model cleanup', passed: false, detail: cleanupError.message });
      if (!failure) failure = cleanupError;
    }
  }
  const report = {
    schemaVersion: '1.0', scenario: scenario.name, model, studio, gateway,
    startedAt, finishedAt: new Date().toISOString(), passed: !failure,
    application: studioGate.application, element: studioGate.element,
    mount: mountedSummary, browserErrors, screenshot, cleanupRequested: cleanupModel, checks,
  };
  const reportPath = resolve(scenarioDir,
    studioGate.report || `../../dist/certification/${scenario.name}-studio-latest.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nStudio certification report: ${reportPath}\n`);
}

if (failure) throw failure;
process.stdout.write(`\nPASS ${scenario.name} Studio mount: ${checks.length} checks\n`);
