/**
 * End-to-end integration test against a LIVE AgenticNetOS stack — the ad-hoc
 * probes used during development, codified so the verification is repeatable and
 * lives with the code.
 *
 * Gated: only runs with AGENTICOS_IT=1 and a reachable gateway. Example:
 *   AGENTICOS_IT=1 \
 *   AGENTICOS_GATEWAY_URL=http://localhost:8083 \
 *   AGENTICOS_ADMIN_SECRET=$(cat ../agentic-net-gateway/data/jwt/admin-secret) \
 *   AGENTICOS_MODELS=mcp-it \
 *   npx vitest run test/integration.test.ts
 *
 * Drives the REAL server through an in-memory MCP transport with a real
 * AppContext (so tool calls make real gateway/master/node round-trips). Uses a
 * dedicated model so it never touches user data; auto-creates it if missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const IT = process.env.AGENTICOS_IT === '1' && !!process.env.AGENTICOS_ADMIN_SECRET;

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* leave as string */
  }
  return { isError: !!res.isError, data };
}

async function poll(client: Client, place: string, timeoutMs = 40000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { isError, data } = await callTool(client, 'query_tokens', { place });
    if (!isError && (data?.resultCount ?? 0) > 0) return data;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

describe.runIf(IT)('@agenticnets/mcp — live integration', () => {
  let client: Client;
  let ctx: AppContext;

  beforeAll(async () => {
    const config = loadConfig();
    ctx = new AppContext(config);
    // Ensure the target model exists (idempotent — 4xx if already there).
    await ctx.client
      .masterApi('POST', '/admin/models', { modelId: config.models[0], name: 'MCP IT' })
      .catch(() => undefined);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'it', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }, 60000);

  afterAll(async () => {
    await client?.close();
  });

  it('deploys the working-memory template (idempotent)', async () => {
    const { isError, data } = await callTool(client, 'deploy_template', { template: 'working-memory' });
    expect(isError).toBe(false);
    expect(data.netId).toBe('memory');
    expect(data.started).toContain('t-mem-distill');
  });

  it('memory_write → memory_recall roundtrip (exact, non-distilled place)', async () => {
    // Recall against a place the distiller does NOT rewrite, so the assertion is
    // deterministic (the LLM distiller paraphrases, so notes-text is not stable).
    const marker = `it-marker-${Date.now()}`;
    const w = await callTool(client, 'memory_write', { place: 'decisions', text: `Decision ${marker} recorded for the recall roundtrip.` });
    expect(w.isError).toBe(false);
    const r = await callTool(client, 'memory_recall', { query: marker, place: 'decisions' });
    expect(r.isError).toBe(false);
    expect(r.data.count).toBeGreaterThan(0);
    expect(r.data.matches[0].preview).toContain(marker);
  }, 30000);

  it('the always-on distiller turns an inbox capture into a note', async () => {
    await callTool(client, 'memory_write', { place: 'inbox', text: `Distiller feed at ${Date.now()}: bound monitoring behind a compose profile.` });
    // Assert a note appears (server-side LLM ran) WITHOUT requiring specific text —
    // the distiller paraphrases by design.
    const notes = await poll(client, 'p-mem-notes', 60000);
    expect(notes, 'distiller produced a note').not.toBeNull();
    expect(notes.resultCount).toBeGreaterThan(0);
  }, 90000);

  it('memory_link → memory_graph shows the edge', async () => {
    await callTool(client, 'memory_link', { from: 'decisions', to: 'knowledge', label: 'it-edge' });
    const g = await callTool(client, 'memory_graph', { start: 'decisions', depth: 2 });
    expect(g.isError).toBe(false);
    expect(g.data.edges.some((e: any) => e.to === 'p-mem-knowledge')).toBe(true);
  }, 30000);

  it('crystallization: scaffold pre-wired command tool-net → invoke E2E', async () => {
    const name = `it-cmd-${Date.now()}`;
    const sc = await callTool(client, 'scaffold_tool_net', { name, transitionKind: 'command' });
    expect(sc.isError).toBe(false);
    const netId = sc.data.netId as string;
    expect(netId).toBeTruthy();
    const inv = await callTool(client, 'invoke_tool_net', {
      netId,
      sessionId: 'tools',
      input: { command: 'echo integration-crystallized' },
      timeoutMs: 60000,
    });
    expect(inv.isError).toBe(false);
    expect(JSON.stringify(inv.data)).toContain('integration-crystallized');
  }, 90000);

  it('error ergonomics: unknown transition → actionable not-found', async () => {
    const { isError, data } = await callTool(client, 'fire_once', { transitionId: 't-does-not-exist' });
    expect(isError).toBe(true);
    expect(String(data.error ?? data)).toMatch(/not found/i);
    expect(String(data.error ?? data)).toMatch(/net_overview/i);
  });

  it('dev-team: user task grooms and advances to done', async () => {
    const rep = await callTool(client, 'deploy_template', { template: 'dev-team' });
    expect(rep.isError).toBe(false);
    const title = `IT task ${Date.now()}`;
    await callTool(client, 'memory_write', { place: 'p-team-backlog', data: { title, description: 'integration', status: 'backlog' } });
    const ready = await poll(client, 'p-team-task-ready', 40000);
    expect(ready, 'groom shaped the task').not.toBeNull();
    await callTool(client, 'fire_once', { transitionId: 't-team-claim' });
    expect(await poll(client, 'p-team-in-progress', 20000)).not.toBeNull();
    await callTool(client, 'fire_once', { transitionId: 't-team-submit' });
    expect(await poll(client, 'p-team-review', 20000)).not.toBeNull();
    await callTool(client, 'fire_once', { transitionId: 't-team-complete' });
    expect(await poll(client, 'p-team-done', 20000)).not.toBeNull();
  }, 120000);
});
