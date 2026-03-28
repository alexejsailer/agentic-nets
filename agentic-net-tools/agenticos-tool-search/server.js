const http = require('http');
const https = require('https');
const { load } = require('cheerio');

const PORT = process.env.PORT || 8080;

const OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'AgenticOS Web Search Tool',
    version: '1.0.0',
    description: 'Searches the web via DuckDuckGo HTML and returns structured results'
  },
  paths: {
    '/search': {
      post: {
        summary: 'Search the web and return results',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', description: 'Search query' },
                  maxResults: { type: 'integer', default: 10, description: 'Max results to return' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Search results' },
          '400': { description: 'Invalid request' },
          '502': { description: 'Search error' }
        }
      }
    },
    '/health': { get: { summary: 'Health check', responses: { '200': { description: 'Healthy' } } } },
    '/openapi.json': { get: { summary: 'OpenAPI spec', responses: { '200': { description: 'Spec' } } } }
  }
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function httpPost(url, postData, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: headers || {}
    };

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
    req.end();
  });
}

async function searchDuckDuckGo(query, maxResults) {
  const startTime = Date.now();

  const postData = `q=${encodeURIComponent(query)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; AgenticOS-Search/1.0)',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  const response = await httpPost('https://html.duckduckgo.com/html/', postData, headers);

  if (response.status !== 200) {
    throw new Error(`DuckDuckGo returned status ${response.status}`);
  }

  const $ = load(response.body);
  const results = [];

  $('.result').each((i, el) => {
    if (results.length >= maxResults) return false;

    const titleEl = $(el).find('.result__a');
    const snippetEl = $(el).find('.result__snippet');

    const title = titleEl.text().trim();
    let url = titleEl.attr('href') || '';

    // DuckDuckGo wraps URLs in redirect links — extract the actual URL
    if (url.includes('uddg=')) {
      try {
        const parsed = new URL(url, 'https://duckduckgo.com');
        url = decodeURIComponent(parsed.searchParams.get('uddg') || url);
      } catch (_) { /* keep original */ }
    }

    const snippet = snippetEl.text().trim();

    if (title && url) {
      results.push({ title, url, snippet });
    }
  });

  return {
    success: true,
    query,
    results,
    resultCount: results.length,
    metadata: {
      searchedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime
    }
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    return json(res, 200, { status: 'healthy', tool: 'agenticos-tool-search', timestamp: new Date().toISOString() });
  }

  if (req.url === '/openapi.json') {
    return json(res, 200, OPENAPI_SPEC);
  }

  if (req.url === '/search' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let params;
      try {
        params = JSON.parse(body);
      } catch (_) {
        return json(res, 400, { success: false, error: 'Invalid JSON body' });
      }

      if (!params.query) {
        return json(res, 400, { success: false, error: 'Missing required field: query' });
      }

      if (typeof params.query !== 'string' || params.query.trim().length === 0) {
        return json(res, 400, { success: false, error: 'Query must be a non-empty string' });
      }

      const maxResults = Math.min(params.maxResults || 10, 30);

      try {
        const result = await searchDuckDuckGo(params.query.trim(), maxResults);
        json(res, 200, result);
      } catch (err) {
        json(res, 502, {
          success: false,
          query: params.query,
          error: err.message,
          metadata: { searchedAt: new Date().toISOString() }
        });
      }
    });
    return;
  }

  json(res, 404, { error: 'Not found. Available endpoints: POST /search, GET /health, GET /openapi.json' });
});

server.listen(PORT, () => {
  console.log(`AgenticOS Web Search Tool listening on port ${PORT}`);
});
