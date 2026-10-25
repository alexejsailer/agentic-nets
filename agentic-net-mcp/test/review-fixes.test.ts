/**
 * The defects a review of the Explorer and Focus tools found on 2026-10-17, each pinned by one test:
 * fields the Interview needs reach it, a setup state gets the next step that fits it, and "not installed"
 * is an answer, never a stale status or a raw gateway error.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

function config(): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp',
    nodeHost: 'localhost:8080', transport: 'stdio', httpPort: 0,
    llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-review-fixes-test.json',
    persistAllowlist: false, nativeTools: 'curated', reviewTools: true,
  } as McpConfig;
}

async function connect(master: (method: string, path: string, body?: any) => any) {
  const ctx = new AppContext(config());
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  (ctx.client as any).masterApi = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    return master(method, path, body);
  };
  const server = createServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, calls };
}

const text = async (client: Client, name: string, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);

function gatewayError(status: number, body: unknown): Error {
  const err: any = new Error(`Gateway ${status}`);
  err.status = status;
  err.body = typeof body === 'string' ? body : JSON.stringify(body);
  return err;
}

describe('review fixes 2026-10-17', () => {
  it('curate_model ask hands requestId and supersedes to the Interview', async () => {
    const { client, calls } = await connect(() => ({ success: true }));
    await text(client, 'curate_model', { action: 'ask', subjectKey: 'rules::power', question: 'Which gap?', promptId: 'q-2',
      requestId: 'r-own-1', supersedes: 'q-1', evidence: ['e'], reasoning: 'r', options: ['a', 'b'] });
    const ask = calls.find(c => c.path.includes('/interview/actions/ask'));
    expect(ask?.body).toMatchObject({ promptId: 'q-2', requestId: 'r-own-1', supersedes: 'q-1' });
  });

  it('curate_model on a model without Curation says what to install', async () => {
    const { client } = await connect(() => { throw gatewayError(400, { error: "application 'curation' is not installed in model 'm1'" }); });
    const out = await text(client, 'curate_model', { action: 'confirm', subjectKey: 'rules::power' });
    expect(out).toMatchObject({ available: false, reason: 'not-installed', application: 'curation' });
    expect(out.hint).toContain('hub_install {name:"curation", version:"latest", model:"m1"}');
  });

  it('hand_over without the master\'s MCP url never asks to reconfigure the root or to grant', async () => {
    const { client } = await connect(() => { throw gatewayError(409, { state: 'needs-setup', runner: 'coder', missing: ['mcp-url'], hint: 'set agenticos.mcp.self.url' }); });
    const out = await text(client, 'hand_over', { kind: 'explain', subject: 'rules::power' });
    expect(out.next).toContain('agenticos.mcp.self.url');
    expect(out.next).not.toContain('refiner_configure');
    expect(out.next).not.toContain('grant');
  });

  it('hand_over passes a requestId on for a retry', async () => {
    const { client, calls } = await connect(() => ({ state: 'running', requestId: 'hand-1', runner: 'coder' }));
    await text(client, 'hand_over', { kind: 'refinement', requestId: 'hand-1' });
    expect(calls.find(c => c.path.includes('/handover'))?.body).toMatchObject({ requestId: 'hand-1' });
  });

  it('refiner_status on a model without Focus is a not-installed answer, not a status with a stale hint', async () => {
    const { client } = await connect(() => ({ modelId: 'm1', installed: false, hint: 'old text' }));
    const out = await text(client, 'refiner_status', {});
    expect(out).toMatchObject({ available: false, reason: 'not-installed', application: 'refiner' });
    expect(out.hint).not.toContain('old text');
  });

  it('focus_scope on a model without Focus shows the slice and names what the next steps need', async () => {
    const { client } = await connect((_m, path) => path.includes('/handover') ? { installed: false } : { scope: 'domain:a', core: [], counts: {} });
    const out = await text(client, 'focus_scope', { scope: 'domain:a' });
    expect(out.focusInstalled).toBe(false);
    expect(out.next).toContain('hub_install {name:"refiner"');
  });

  it('refine_model can list the deferred subjects', async () => {
    const { client, calls } = await connect(() => ({ items: [], total: 0 }));
    await text(client, 'refine_model', { includeDeferred: true });
    expect(calls[0].path).toContain('includeDeferred=true');
  });
});
