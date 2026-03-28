const http = require('http');
const Parser = require('rss-parser');

const PORT = process.env.PORT || 8080;
const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'AgenticOS-RSS/1.0' }
});

const OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'AgenticOS RSS Feed Tool',
    version: '1.0.0',
    description: 'Fetches and parses RSS/Atom feeds, returning structured feed items'
  },
  paths: {
    '/fetch': {
      post: {
        summary: 'Fetch an RSS or Atom feed',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['feedUrl'],
                properties: {
                  feedUrl: { type: 'string', description: 'URL of the RSS/Atom feed' },
                  maxItems: { type: 'integer', default: 20, description: 'Max items to return' },
                  since: { type: 'string', description: 'ISO timestamp — only return items after this date' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Feed items' },
          '400': { description: 'Invalid request' },
          '502': { description: 'Feed fetch error' }
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

async function fetchFeed(feedUrl, maxItems, since) {
  const startTime = Date.now();
  const sinceDate = since ? new Date(since) : null;

  const feed = await parser.parseURL(feedUrl);

  let items = (feed.items || []).map(item => ({
    title: item.title || '',
    link: item.link || '',
    pubDate: item.pubDate || item.isoDate || '',
    content: (item.contentSnippet || item.content || '').substring(0, 10000),
    categories: (item.categories || []).join(', '),
    author: item.creator || item.author || ''
  }));

  if (sinceDate) {
    items = items.filter(item => {
      if (!item.pubDate) return true;
      return new Date(item.pubDate) > sinceDate;
    });
  }

  items = items.slice(0, maxItems);

  return {
    success: true,
    feedTitle: feed.title || '',
    feedUrl,
    items,
    metadata: {
      totalItems: items.length,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime
    }
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    return json(res, 200, { status: 'healthy', tool: 'agenticos-tool-rss', timestamp: new Date().toISOString() });
  }

  if (req.url === '/openapi.json') {
    return json(res, 200, OPENAPI_SPEC);
  }

  if (req.url === '/fetch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let params;
      try {
        params = JSON.parse(body);
      } catch (_) {
        return json(res, 400, { success: false, error: 'Invalid JSON body' });
      }

      if (!params.feedUrl) {
        return json(res, 400, { success: false, error: 'Missing required field: feedUrl' });
      }

      try {
        new URL(params.feedUrl);
      } catch (_) {
        return json(res, 400, { success: false, error: `Invalid URL: ${params.feedUrl}` });
      }

      const maxItems = Math.min(params.maxItems || 20, 100);
      const since = params.since || null;

      try {
        const result = await fetchFeed(params.feedUrl, maxItems, since);
        json(res, 200, result);
      } catch (err) {
        json(res, 502, {
          success: false,
          feedUrl: params.feedUrl,
          error: err.message,
          metadata: { fetchedAt: new Date().toISOString() }
        });
      }
    });
    return;
  }

  json(res, 404, { error: 'Not found. Available endpoints: POST /fetch, GET /health, GET /openapi.json' });
});

server.listen(PORT, () => {
  console.log(`AgenticOS RSS Feed Tool listening on port ${PORT}`);
});
