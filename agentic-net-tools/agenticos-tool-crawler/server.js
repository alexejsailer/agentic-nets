const http = require('http');
const { load } = require('cheerio');

const PORT = process.env.PORT || 8080;

const OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'AgetnticOS Web Crawler Tool',
    version: '1.0.0',
    description: 'Crawls web pages and returns structured content with CSS selector support'
  },
  paths: {
    '/crawl': {
      post: {
        summary: 'Crawl a URL and return structured content',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', description: 'URL to crawl' },
                  selectors: {
                    type: 'object',
                    description: 'CSS selectors for content extraction',
                    properties: {
                      title: { type: 'string', default: 'h1' },
                      content: { type: 'string', default: 'article, .content, main' },
                      links: { type: 'string', default: 'a[href]' }
                    }
                  },
                  maxDepth: { type: 'integer', default: 0, description: '0 = single page' },
                  timeout: { type: 'integer', default: 10000, description: 'Timeout in ms' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Crawl results' },
          '400': { description: 'Invalid request' },
          '500': { description: 'Crawl error' }
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

async function crawlPage(url, selectors, timeout) {
  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AgetnticOS-Crawler/1.0' },
      redirect: 'follow'
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
      return {
        success: false,
        url,
        statusCode: response.status,
        error: `Non-HTML content type: ${contentType}`,
        metadata: { contentType, crawledAt: new Date().toISOString(), durationMs: Date.now() - startTime }
      };
    }

    const html = await response.text();
    const $ = load(html);

    const titleSel = selectors.title || 'h1';
    const contentSel = selectors.content || 'article, .content, main';
    const linksSel = selectors.links || 'a[href]';

    // Extract title
    const title = $(titleSel).first().text().trim() || $('title').text().trim() || '';

    // Extract content
    let content = '';
    const contentEls = $(contentSel);
    if (contentEls.length > 0) {
      content = contentEls.text().trim();
    } else {
      content = $('body').text().trim();
    }
    // Normalize whitespace
    content = content.replace(/\s+/g, ' ').substring(0, 50000);

    // Extract links
    const links = [];
    $(linksSel).each((_, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        try {
          const resolved = new URL(href, url).href;
          if (!links.includes(resolved)) links.push(resolved);
        } catch (_) { /* skip invalid URLs */ }
      }
    });

    return {
      success: true,
      url,
      statusCode: response.status,
      title,
      content,
      links: links.slice(0, 100),
      metadata: {
        contentType,
        contentLength: html.length,
        crawledAt: new Date().toISOString(),
        durationMs: Date.now() - startTime
      }
    };
  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? `Timeout after ${timeout}ms` : err.message;
    return {
      success: false,
      url,
      error: errorMsg,
      metadata: { crawledAt: new Date().toISOString(), durationMs: Date.now() - startTime }
    };
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    return json(res, 200, { status: 'healthy', tool: 'agenticos-tool-crawler', timestamp: new Date().toISOString() });
  }

  if (req.url === '/openapi.json') {
    return json(res, 200, OPENAPI_SPEC);
  }

  if (req.url === '/crawl' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let params;
      try {
        params = JSON.parse(body);
      } catch (_) {
        return json(res, 400, { success: false, error: 'Invalid JSON body' });
      }

      if (!params.url) {
        return json(res, 400, { success: false, error: 'Missing required field: url' });
      }

      try {
        new URL(params.url);
      } catch (_) {
        return json(res, 400, { success: false, error: `Invalid URL: ${params.url}` });
      }

      const selectors = params.selectors || {};
      const timeout = Math.min(params.timeout || 10000, 30000);

      const result = await crawlPage(params.url, selectors, timeout);
      json(res, result.success ? 200 : 502, result);
    });
    return;
  }

  json(res, 404, { error: 'Not found. Available endpoints: POST /crawl, GET /health, GET /openapi.json' });
});

server.listen(PORT, () => {
  console.log(`AgetnticOS Web Crawler Tool listening on port ${PORT}`);
});
