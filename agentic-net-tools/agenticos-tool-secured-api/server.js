const http = require('http');

const PORT = process.env.PORT || 8080;
const VALID_API_KEY = process.env.API_KEY || 'agenticos-test-key-2026';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // CORS + JSON defaults
  res.setHeader('Content-Type', 'application/json');

  // Health check
  if (url.pathname === '/health' && method === 'GET') {
    return res.end(JSON.stringify({
      status: 'healthy',
      tool: 'agenticos-tool-secured-api',
      timestamp: new Date().toISOString()
    }));
  }

  // OpenAPI spec
  if (url.pathname === '/openapi.json' && method === 'GET') {
    return res.end(JSON.stringify({
      openapi: '3.0.0',
      info: {
        title: 'Secured API Tool',
        version: '1.0.0',
        description: 'A test API that requires X-API-Key authentication. Returns data only when a valid API key is provided.'
      },
      paths: {
        '/data': {
          post: {
            summary: 'Fetch secured data',
            description: 'Returns test data if a valid API key is provided in the X-API-Key header.',
            security: [{ apiKey: [] }],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string', description: 'Search query or topic' }
                    }
                  }
                }
              }
            },
            responses: {
              200: { description: 'Authenticated — data returned' },
              401: { description: 'Missing or invalid API key' }
            }
          }
        },
        '/health': {
          get: { summary: 'Health check', responses: { 200: { description: 'Healthy' } } }
        }
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' }
        }
      }
    }));
  }

  // Main secured endpoint
  if (url.pathname === '/data' && method === 'POST') {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      res.writeHead(401);
      return res.end(JSON.stringify({
        success: false,
        error: 'Missing X-API-Key header',
        hint: 'Provide a valid API key in the X-API-Key header'
      }));
    }

    if (apiKey !== VALID_API_KEY) {
      res.writeHead(403);
      return res.end(JSON.stringify({
        success: false,
        error: 'Invalid API key',
        provided: apiKey.substring(0, 8) + '...'
      }));
    }

    // Authenticated — collect request body and respond
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        authenticated: true,
        query: parsed.query || null,
        data: {
          message: `Secured response for query: ${parsed.query || 'none'}`,
          items: [
            { id: 1, title: 'Vault-protected endpoint works', category: 'security' },
            { id: 2, title: 'Credentials fetched just-in-time', category: 'architecture' },
            { id: 3, title: 'No secrets in inscription JSON', category: 'best-practice' }
          ],
          generatedAt: new Date().toISOString()
        }
      }));
    });
    return;
  }

  // 404 for everything else
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found', availableEndpoints: ['/data', '/health', '/openapi.json'] }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`agenticos-tool-secured-api listening on port ${PORT}`);
  console.log(`API key required: X-API-Key header`);
});
