const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', tool: 'agenticos-tool-echo', timestamp: new Date().toISOString() }));
    return;
  }

  // OpenAPI spec
  if (req.url === '/openapi.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'AgetnticOS Echo Tool', version: '1.0.0', description: 'Echoes back request data with metadata' },
      paths: {
        '/echo': {
          post: {
            summary: 'Echo request body with metadata',
            requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
            responses: { '200': { description: 'Echoed response' } }
          }
        },
        '/health': {
          get: { summary: 'Health check', responses: { '200': { description: 'Healthy' } } }
        }
      }
    }));
    return;
  }

  // Echo endpoint - accepts any method
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsedBody = null;
    try { parsedBody = JSON.parse(body); } catch (e) { parsedBody = body || null; }

    const response = {
      echo: true,
      tool: 'agenticos-tool-echo',
      timestamp: new Date().toISOString(),
      request: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody,
      },
      metadata: {
        hostname: require('os').hostname(),
        uptime: process.uptime(),
        nodeVersion: process.version,
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));
  });
});

server.listen(PORT, () => {
  console.log(`AgetnticOS Echo Tool listening on port ${PORT}`);
});
