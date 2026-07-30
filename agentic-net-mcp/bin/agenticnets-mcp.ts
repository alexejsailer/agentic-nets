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
import { loadConfig, ConfigError } from '../src/config.js';
import { AppContext } from '../src/context.js';
import { log } from '../src/logger.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from '../src/server.js';

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

  const ctx = new AppContext(config);

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
      if (auth !== `Bearer ${config.httpToken}`) {
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

main().catch((err) => {
  log.error(`[${SERVER_NAME}] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
