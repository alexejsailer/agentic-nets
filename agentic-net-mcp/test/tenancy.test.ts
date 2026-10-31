import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer as createHttpServer, type Server } from 'node:http';
import { AppContext } from '../src/context.js';
import { createServer, TENANCY_WITHHELD } from '../src/server.js';
import { loadConfig, type McpConfig } from '../src/config.js';
import { TenantContexts, TenantKeyError, tenantOfKey } from '../src/tenancy.js';
import { buildInstructions } from '../src/instructions.js';

const ALICE = 'ant_alice_' + 'a'.repeat(32);
const BOB = 'ant_bob_' + 'b'.repeat(32);

let gateway: Server | undefined;

afterEach(() => {
  gateway?.close();
  gateway = undefined;
  vi.restoreAllMocks();
});

/**
 * A stand-in gateway: mints a token per tenant key and lists that tenant's models only, like the
 * real one. Records every request so a test can see which identity each one carried.
 */
async function fakeGateway(models: Record<string, string[]>): Promise<{ url: string; seen: string[]; created: string[] }> {
  const seen: string[] = [];
  const created: string[] = [];
  gateway = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/oauth2/token') {
      const secret = new URLSearchParams(body).get('client_secret') ?? '';
      const tenant = tenantOfKey(secret);
      if (!tenant || !(tenant in models)) {
        res.writeHead(401).end('{"error":"invalid_client"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ access_token: `tok-${tenant}`, token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    const tenant = String(req.headers.authorization ?? '').replace('Bearer tok-', '');
    seen.push(`${tenant} ${req.method} ${req.url}`);
    if (req.url === '/api/admin/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify((models[tenant] ?? []).map((modelId) => ({ modelId }))));
      return;
    }
    if (req.url === '/api/admin/models' && req.method === 'POST') {
      const id = JSON.parse(body).modelId;
      created.push(id);
      models[tenant] = [...(models[tenant] ?? []), id];
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ modelId: id }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', () => resolve()));
  const addr = gateway.address() as any;
  return { url: `http://127.0.0.1:${addr.port}`, seen, created };
}

function tenancyConfig(gatewayUrl: string): McpConfig {
  return loadConfig({ AGENTICOS_TENANCY: 'true', AGENTICOS_GATEWAY_URL: gatewayUrl } as any);
}

async function toolNames(ctx: AppContext): Promise<string[]> {
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  const tools = await client.listTools();
  return tools.tools.map((t) => t.name);
}

describe('tenancy configuration', () => {
  it('needs neither a secret nor a model list, only http, and never persists an allowlist', () => {
    const cfg = loadConfig({ AGENTICOS_TENANCY: 'true' } as any);
    expect(cfg.tenancy).toBe(true);
    expect(cfg.transport).toBe('http');
    expect(cfg.persistAllowlist).toBe(false);
    expect(cfg.nativeTools).toBe('curated');
    expect(cfg.serverAi).toBe(false);
    expect(() => loadConfig({ AGENTICOS_TENANCY: 'true', AGENTICOS_MCP_TRANSPORT: 'stdio' } as any)).toThrow(/http/);
  });

  it('reads the tenant from a key and nothing else', () => {
    expect(tenantOfKey(ALICE)).toBe('alice');
    expect(tenantOfKey('ant_alice_short')).toBeNull();
    expect(tenantOfKey('some-shared-token')).toBeNull();
  });
});

describe('tenant contexts', () => {
  it('give each tenant its own models and its own gateway identity', async () => {
    const gw = await fakeGateway({ alice: ['alice-notes', 'alice-main'], bob: ['bob-work'] });
    const tenants = new TenantContexts(tenancyConfig(gw.url));
    const alice = await tenants.resolve(`Bearer ${ALICE}`);
    const bob = await tenants.resolve(`Bearer ${BOB}`);
    expect(alice.scope.allowed).toEqual(['alice-main', 'alice-notes']);
    expect(alice.scope.defaultModel).toBe('alice-main');
    expect(bob.scope.allowed).toEqual(['bob-work']);
    expect(alice).not.toBe(bob);
    expect(await tenants.resolve(`Bearer ${ALICE}`)).toBe(alice);
    // Each request went out under its own tenant's token.
    expect(gw.seen).toContain('alice GET /api/admin/models');
    expect(gw.seen).toContain('bob GET /api/admin/models');
  });

  it('create a first model for a tenant that has none', async () => {
    const gw = await fakeGateway({ alice: [] });
    const alice = await new TenantContexts(tenancyConfig(gw.url)).resolve(`Bearer ${ALICE}`);
    expect(gw.created).toEqual(['alice-main']);
    expect(alice.scope.allowed).toEqual(['alice-main']);
  });

  it('refuse a missing, shared or unknown key', async () => {
    const gw = await fakeGateway({ alice: ['alice-main'] });
    const tenants = new TenantContexts(tenancyConfig(gw.url));
    await expect(tenants.resolve(undefined)).rejects.toBeInstanceOf(TenantKeyError);
    await expect(tenants.resolve('Bearer shared-operator-token')).rejects.toBeInstanceOf(TenantKeyError);
    await expect(tenants.resolve(`Bearer ${BOB}`)).rejects.toThrow(/not accepted/);
  });
});

describe('the tenant tool surface', () => {
  it('withholds the operator tools and tells the client it is the reasoner', async () => {
    const gw = await fakeGateway({ alice: ['alice-main'] });
    const alice = await new TenantContexts(tenancyConfig(gw.url)).resolve(`Bearer ${ALICE}`);
    const names = await toolNames(alice);
    for (const withheld of TENANCY_WITHHELD) expect(names).not.toContain(withheld);
    expect(names).toContain('create_model');
    expect(names).toContain('prepare_external_fire');
    expect(names).toContain('complete_external_fire');
    const instructions = buildInstructions(alice.config);
    expect(instructions).toContain('You are the reasoner here');
    expect(instructions).toContain("starting with 'alice-'");
  });

  it('prefixes a new model with the tenant', async () => {
    const gw = await fakeGateway({ alice: ['alice-main'] });
    const alice = await new TenantContexts(tenancyConfig(gw.url)).resolve(`Bearer ${ALICE}`);
    const posted: string[] = [];
    vi.spyOn(alice.client, 'nodeApi').mockImplementation(async (method: any, path: any, body: any) => {
      if (method === 'GET' && path === '/admin/models') return [{ modelId: 'alice-main' }];
      if (method === 'POST' && path === '/admin/models') {
        posted.push(body.modelId);
        return { modelId: body.modelId };
      }
      return {};
    });
    vi.spyOn(alice.client, 'masterApi').mockResolvedValue({} as any);
    const server = createServer(alice);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    await client.callTool({ name: 'create_model', arguments: { modelId: 'research' } });
    expect(posted).toEqual(['alice-research']);
    expect(alice.scope.allowed).toContain('alice-research');
  });
});

describe('outside tenancy', () => {
  it('keeps the classic wording unless the platform reports AI off', () => {
    const base: McpConfig = {
      gatewayUrl: 'http://x', models: ['m'], mode: 'rw', session: 's', nodeHost: 'n', transport: 'stdio',
      httpPort: 0, llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
      persistedModels: [], allowlistPath: '/dev/null', persistAllowlist: false,
    };
    expect(buildInstructions(base)).not.toContain('You are the reasoner here');
    expect(buildInstructions({ ...base, serverAi: false })).toContain('You are the reasoner here');
  });

  it('refuses a hub install into an existing model outside the allowlist', async () => {
    const ctx = new AppContext({
      gatewayUrl: 'http://localhost:0', models: ['mine'], mode: 'rw', session: 's', nodeHost: 'n',
      transport: 'stdio', httpPort: 0, llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
      persistedModels: [], allowlistPath: '/dev/null', persistAllowlist: false,
    });
    vi.spyOn(ctx.client, 'nodeApi').mockResolvedValue([{ modelId: 'mine' }, { modelId: 'someone-else' }] as any);
    const install = vi.spyOn(ctx.master, 'hubInstall').mockResolvedValue({ ok: true } as any);
    vi.spyOn(ctx.master, 'hubArtifact').mockResolvedValue({ kind: 'net' } as any);
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    const res: any = await client.callTool({ name: 'hub_install', arguments: { name: 'x', version: 'latest', targetModelId: 'someone-else' } });
    expect(res.isError).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });
});
