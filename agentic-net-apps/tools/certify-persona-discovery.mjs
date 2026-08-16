#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[index + 1] || 'true']);
  return all;
}, []));
if (!args.model) throw new Error('Usage: certify-persona-discovery.mjs --model <modelId> [--persona persona-independent-reviewer]');

const model = args.model;
const persona = args.persona || 'persona-independent-reviewer';
const gateway = String(args.gateway || process.env.AGENTICOS_GATEWAY || 'http://127.0.0.1:8083').replace(/\/$/, '');
const secretFile = resolve(args['admin-secret-file'] || `${homedir()}/.agenticos/desktop/gateway/jwt/admin-secret`);
await access(secretFile);
const mcpEntry = resolve(import.meta.dirname, '../../agentic-net-mcp/dist/bin/agenticnets-mcp.js');
const reportPath = resolve(args.report || resolve(import.meta.dirname,
  '../dist/certification/persona-discovery-latest.json'));
const checks = [];
const startedAt = new Date().toISOString();
let selectedApplication;
let selectedRequestId;
let failure;
let connected = false;

function check(name, detail = '') {
  checks.push({ name, passed: true, detail });
  process.stdout.write(`✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
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

function decode(result, tool) {
  const text = result.content?.find(item => item.type === 'text')?.text || '{}';
  let data;
  try { data = JSON.parse(text); } catch { data = { text }; }
  if (result.isError) throw new Error(`${tool}: ${data.error || text}`);
  return data;
}

async function call(client, tool, input) {
  return decode(await client.callTool({ name: tool, arguments: input }), tool);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpEntry],
  env: {
    ...process.env,
    AGENTICOS_GATEWAY_URL: gateway,
    AGENTICOS_GATEWAY_SECRET_FILE: secretFile,
    AGENTICOS_MODELS: model,
    AGENTICOS_MODE: 'rw',
    AGENTICOS_ALLOW_MODEL_CREATE: 'false',
    AGENTICOS_PERSIST_ALLOWLIST: 'false',
    AGENTICOS_NATIVE_TOOLS: 'curated',
    AGENTICOS_MCP_TRANSPORT: 'stdio',
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'blind-persona-certifier', version: '1.0.0' });

try {
  await waitForGateway();
  await client.connect(transport);
  connected = true;
  const advertised = await client.listTools();
  const names = new Set(advertised.tools.map(tool => tool.name));
  for (const required of ['application_list', 'application_describe', 'application_action', 'query_tokens']) {
    assert.ok(names.has(required), `bundled MCP surface is missing ${required}`);
  }
  const actionTool = advertised.tools.find(tool => tool.name === 'application_action');
  assert.ok(actionTool?.inputSchema?.properties?.idempotencyKey,
    'application_action does not advertise idempotencyKey');
  check('bundled MCP advertises discovery, action, query, and retry identity');

  const listed = await call(client, 'application_list', { model });
  const applications = listed.applications || listed;
  assert.ok(Array.isArray(applications) && applications.length,
    `no applications discovered: ${JSON.stringify(listed)}`);

  // The Persona is intentionally not given an application name or place id. Select a capability
  // only from its machine-readable protocol: pending work with an approval terminal transition.
  let selected;
  for (const summary of applications) {
    const described = await call(client, 'application_describe', {
      model, name: summary.sessionId || summary.name,
    });
    const workflow = described.agentProtocol?.workflow || [];
    if ((described.agentProtocol?.readyStatuses || []).includes('pending')
        && workflow.some(step => step.from === 'pending' && step.to === 'approved')) {
      selected = described;
      break;
    }
  }
  assert.ok(selected, 'no discovered application describes a pending → approved workflow');
  assert.ok(selected.agentProtocol?.rules?.some(rule => /request|identity|separation/i.test(rule)),
    'the discovered protocol does not teach separation of duty');
  selectedApplication = selected.name;
  check('blind Persona selected application from agentProtocol',
    `${selected.name}, not a hard-coded route/place`);

  const taskRole = selected.agentProtocol.taskStoreRole;
  const requestStore = selected.stores.find(store => store.role === taskRole);
  assert.ok(requestStore?.placeId, `taskStoreRole ${taskRole} did not resolve to a place`);
  const queried = await call(client, 'query_tokens', {
    model, place: requestStore.placeId, arcql: 'FROM $', limit: 100,
  });
  const tokens = queried.tokens || queried.results || queried.items || [];
  const ready = tokens.find(token => {
    const properties = token.properties || token.data || token;
    return properties.status === 'pending' && properties.requestedBy !== persona;
  });
  assert.ok(ready, `no pending request eligible for ${persona}`);
  const properties = ready.properties || ready.data || ready;
  const approvalStep = selected.agentProtocol.workflow.find(step => step.from === 'pending' && step.to === 'approved');
  const approvalAction = selected.actions.find(action => action.name === approvalStep.action);
  assert.ok(approvalAction, `workflow action ${approvalStep.action} is not declared`);
  const requestIdField = selected.agentProtocol.requestIdField || 'requestId';
  const input = {
    [requestIdField]: properties[requestIdField],
    actor: persona,
    note: 'Blind Persona acceptance: discovered contract, checked requester identity, and independently approved.',
  };
  for (const required of approvalAction.inputSchema?.required || []) {
    assert.notEqual(input[required], undefined, `cannot derive required approval input '${required}' from protocol`);
  }
  const retryIdentity = `blind-persona:${properties[requestIdField]}:approve`;
  assert.match(retryIdentity, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,
    `derived idempotency key is not valid: ${retryIdentity}`);
  const result = await call(client, 'application_action', {
    model, name: selected.sessionId || selected.name, action: approvalAction.name, input,
    idempotencyKey: retryIdentity,
  });
  assert.equal(result.accepted, true);
  selectedRequestId = properties[requestIdField];
  check('Persona invoked discovered action with retry identity',
    `${persona} → ${approvalAction.name}`);

  const verified = await call(client, 'query_tokens', {
    model, place: requestStore.placeId, arcql: 'FROM $', limit: 100,
  });
  const after = verified.tokens || verified.results || verified.items || [];
  const canonical = after.find(token => {
    const value = token.properties || token.data || token;
    return value[requestIdField] === properties[requestIdField];
  });
  const canonicalProperties = canonical?.properties || canonical?.data || canonical;
  assert.equal(canonicalProperties?.status, 'approved');
  assert.equal(canonicalProperties?.decidedBy, persona);
  check('Persona re-read canonical state',
    `${properties[requestIdField]} approved by ${persona}`);
} catch (error) {
  failure = error;
  checks.push({ name: 'Persona certification', passed: false,
    detail: error.stack || error.message || String(error) });
} finally {
  if (connected) {
    try { await client.close(); } catch (closeError) {
      checks.push({ name: 'MCP client cleanup', passed: false, detail: closeError.message });
      if (!failure) failure = closeError;
    }
  }
  const report = {
    schemaVersion: '1.0', model, persona, gateway, selectedApplication, selectedRequestId,
    startedAt, finishedAt: new Date().toISOString(), passed: !failure, checks,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nPersona certification report: ${reportPath}\n`);
}

if (failure) throw failure;
process.stdout.write(`\nPASS blind Persona discovery: ${checks.length} checks\n`);
