import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import { createAllowlistStoreAt } from '../src/allowlist-store.js';
import type { McpConfig } from '../src/config.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agenticnets-create-model-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function config(): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0',
    models: ['base'],
    mode: 'rw',
    session: 'test-session',
    nodeHost: 'localhost:8080',
    transport: 'stdio',
    httpPort: 0,
    llmProvider: 'claude-code',
    llmTier: 'medium',
    allowModelCreate: true,
    persistedModels: [],
    allowlistPath: join(stateDir, 'allowlist.json'),
    persistAllowlist: true,
  };
}

async function connect(ctx: AppContext): Promise<Client> {
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function data(response: any): any {
  return JSON.parse(response.content[0].text);
}

describe('create_model durability and recovery', () => {
  it('list_models sees a newly persisted grant in the same session', async () => {
    const cfg = config();
    const ctx = new AppContext(cfg);
    let exists = false;
    vi.spyOn(ctx.client, 'nodeApi').mockImplementation(async (method: any, path: any) => {
      if (method === 'GET' && path === '/admin/models') {
        return exists ? [{ modelId: 'minted', name: 'Minted', state: 'ACTIVE' }] : [];
      }
      if (method === 'POST' && path === '/admin/models') {
        exists = true;
        return { modelId: 'minted' };
      }
      throw new Error(`test intentionally omits workspace endpoint ${method} ${path}`);
    });
    const client = await connect(ctx);

    const created: any = await client.callTool({
      name: 'create_model',
      arguments: { modelId: 'minted' },
    });
    expect(created.isError).not.toBe(true);
    expect(createAllowlistStoreAt(cfg.allowlistPath).read()).toEqual(['minted']);

    const listed: any = await client.callTool({ name: 'list_models', arguments: {} });
    expect(data(listed).models).toContainEqual(expect.objectContaining({
      modelId: 'minted',
      allowed: true,
      allowedVia: 'persisted',
    }));
    await client.close();
  });

  it('persists partial profile creation and retries through the idempotent profile endpoint', async () => {
    const cfg = config();
    const ctx = new AppContext(cfg);
    let exists = false;
    vi.spyOn(ctx.client, 'nodeApi').mockImplementation(async (method: any, path: any) => {
      if (method === 'GET' && path === '/admin/models') {
        return exists ? [{ modelId: 'profiled', name: 'Profiled', state: 'ACTIVE' }] : [];
      }
      throw new Error(`test intentionally omits workspace endpoint ${method} ${path}`);
    });
    vi.spyOn(ctx.client, 'masterApi').mockImplementation(async (method: any, path: any) => {
      if (method === 'POST' && path === '/admin/models') {
        exists = true;
        const error: any = new Error('profile incomplete');
        error.status = 500;
        error.body = JSON.stringify({
          modelCreated: true,
          modelProfile: { ready: false, artifacts: [{ name: 'context-curator', ready: false }] },
        });
        throw error;
      }
      if (method === 'POST' && path === '/admin/models/profiled/profile') {
        return { profile: 'knowledge', ready: true, artifacts: [] };
      }
      throw new Error(`unexpected master endpoint ${method} ${path}`);
    });
    const client = await connect(ctx);

    const partial: any = await client.callTool({
      name: 'create_model',
      arguments: { modelId: 'profiled', profile: 'knowledge' },
    });
    expect(partial.isError).toBe(true);
    expect(createAllowlistStoreAt(cfg.allowlistPath).read()).toEqual(['profiled']);

    const retried: any = await client.callTool({
      name: 'create_model',
      arguments: { modelId: 'profiled', profile: 'knowledge' },
    });
    expect(retried.isError).not.toBe(true);
    expect(data(retried)).toMatchObject({
      created: false,
      existed: true,
      modelProfile: { profile: 'knowledge', ready: true },
    });
    await client.close();
  });
});
