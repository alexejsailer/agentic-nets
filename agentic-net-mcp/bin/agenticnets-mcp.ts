/**
 * @agenticnets/mcp entrypoint.
 *
 * stdio (default): for `claude mcp add ... -- npx @agenticnets/mcp`.
 * http: AGENTICOS_MCP_TRANSPORT=http — streamable-HTTP endpoint for the compose
 *   image (stateless mode; bearer token required via AGENTICOS_MCP_HTTP_TOKEN).
 *
 * stdout is the MCP protocol channel — every diagnostic goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig, ConfigError } from '../src/config.js';
import { AppContext } from '../src/context.js';
import { log } from '../src/logger.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from '../src/server.js';
import { startAppPromptRefresh } from '../src/app-prompts.js';
import { TenantContexts, TenantKeyError } from '../src/tenancy.js';

/**
 * Ask the platform whether it reasons itself (GET /api/system/features). With AI off the connected
 * client is the only reasoner, and the instructions say so. Best effort: an older master has no
 * such route and keeps today's wording.
 */
async function probeServerAi(ctx: AppContext): Promise<void> {
  try {
    const f: any = await Promise.race([
      ctx.client.masterApi('GET', '/system/features'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    if (f && typeof f.ai === 'boolean') ctx.config.serverAi = f.ai;
  } catch {
    // unknown: keep the default wording
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`[${SERVER_NAME}] configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (config.tenancy) {
    await serveTenants(config);
    return;
  }

  const ctx = new AppContext(config);
  // Application prompts come from the NetHub catalog; loaded in the background, retried until it answers.
  startAppPromptRefresh(ctx);
  await probeServerAi(ctx);

  if (config.transport === 'stdio') {
    const server = createServer(ctx);
    await server.connect(new StdioServerTransport());
    log.info(
      `[${SERVER_NAME}] v${SERVER_VERSION} on stdio — models=[${config.models.join(', ')}] mode=${config.mode} gateway=${config.gatewayUrl}`,
    );
    return;
  }

  // Streamable HTTP (stateless: a fresh server+transport pair per request, no
  // session bookkeeping — fits the compose single-container deployment).
  const httpServer = createHttpServer(async (req, res) => {
    try {
      // Liveness probe for supervisors (desktop launcher, compose healthcheck) —
      // deliberately before the bearer check, and deliberately content-free.
      if (req.method === 'GET' && (req.url ?? '') === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      const auth = req.headers.authorization ?? '';
      // Constant-time bearer comparison (hash both to a fixed length so neither the token
      // value nor its length leaks through timing). A missing configured token denies all.
      const expected = config.httpToken ? `Bearer ${config.httpToken}` : '';
      const authOk = expected.length > 0 && timingSafeEqual(
        createHash('sha256').update(auth).digest(),
        createHash('sha256').update(expected).digest());
      if (!authOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.method !== 'POST' || !(req.url ?? '/').startsWith('/mcp')) {
        res.writeHead(req.method === 'GET' ? 405 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: req.method === 'GET' ? 'stateless server: POST /mcp only' : 'not found' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;

      const server = createServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      log.error(`[${SERVER_NAME}] http error: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    }
  });

  const httpHost = config.httpHost ?? '0.0.0.0';
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    log.error(
      `[${SERVER_NAME}] http listen failed on ${httpHost}:${config.httpPort}: ${err.code ?? err.message}`,
    );
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    log.info(`[${SERVER_NAME}] ${signal} — shutting down`);
    httpServer.close(() => process.exit(0));
    // In-flight SSE responses can hold the server open indefinitely; cap the drain.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  httpServer.listen(config.httpPort, httpHost, () => {
    log.info(
      `[${SERVER_NAME}] v${SERVER_VERSION} on http://${httpHost}:${config.httpPort}/mcp — models=[${config.models.join(', ')}] mode=${config.mode}`,
    );
  });
}

/**
 * Multi-tenant HTTP: no shared secret, no shared state. Each request's bearer is a tenant key; the
 * request is served by that tenant's own context (its gateway token, its models).
 */
async function serveTenants(config: ReturnType<typeof loadConfig>): Promise<void> {
  const tenants = new TenantContexts(config);
  const httpServer = createHttpServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url ?? '') === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', tenancy: true }));
        return;
      }
      if (req.method !== 'POST' || !(req.url ?? '/').startsWith('/mcp')) {
        res.writeHead(req.method === 'GET' ? 405 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: req.method === 'GET' ? 'stateless server: POST /mcp only' : 'not found' }));
        return;
      }
      let ctx: AppContext;
      try {
        ctx = await tenants.resolve(req.headers.authorization);
      } catch (err: any) {
        const status = err instanceof TenantKeyError ? err.status : 401;
        res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) });
        res.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'unavailable', message: err?.message ?? String(err) }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 8 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'request too large' }));
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const server = createServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      log.error(`[${SERVER_NAME}] http error: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    }
  });
  const httpHost = config.httpHost ?? '0.0.0.0';
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    log.error(`[${SERVER_NAME}] http listen failed on ${httpHost}:${config.httpPort}: ${err.code ?? err.message}`);
    process.exit(1);
  });
  const shutdown = (signal: string) => {
    log.info(`[${SERVER_NAME}] ${signal} — shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  httpServer.listen(config.httpPort, httpHost, () => {
    log.info(`[${SERVER_NAME}] v${SERVER_VERSION} multi-tenant on http://${httpHost}:${config.httpPort}/mcp — gateway=${config.gatewayUrl}`);
  });
}

main().catch((err) => {
  log.error(`[${SERVER_NAME}] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
