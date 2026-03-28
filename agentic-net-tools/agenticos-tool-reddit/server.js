const http = require('http');

const PORT = process.env.PORT || 8080;
const USER_AGENT = 'AgenticOS-RedditTool/1.0.0 (by /u/agenticos-bot)';
const RATE_LIMIT_MS = 6000; // ~10 req/min for unauthenticated
let lastRequestTime = 0;

const OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'AgenticOS Reddit Tool',
    version: '1.0.0',
    description: 'Fetches posts, comments, and search results from Reddit using the public JSON API'
  },
  paths: {
    '/posts': {
      post: {
        summary: 'Fetch posts from a subreddit',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['subreddit'],
                properties: {
                  subreddit: { type: 'string', description: 'Subreddit name (without r/)' },
                  sort: { type: 'string', enum: ['hot', 'new', 'top', 'rising'], default: 'hot' },
                  limit: { type: 'integer', default: 10, maximum: 25 },
                  timeframe: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'week' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Posts fetched' }, '400': { description: 'Invalid request' }, '502': { description: 'Reddit API error' } }
      }
    },
    '/search': {
      post: {
        summary: 'Search posts in a subreddit',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', description: 'Search query' },
                  subreddit: { type: 'string', description: 'Subreddit to search in (optional, searches all if omitted)' },
                  sort: { type: 'string', enum: ['relevance', 'hot', 'top', 'new', 'comments'], default: 'relevance' },
                  limit: { type: 'integer', default: 10, maximum: 25 },
                  timeframe: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'year' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Search results' }, '400': { description: 'Invalid request' }, '502': { description: 'Reddit API error' } }
      }
    },
    '/comments': {
      post: {
        summary: 'Fetch top comments from a post',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['postId', 'subreddit'],
                properties: {
                  postId: { type: 'string', description: 'Reddit post ID (e.g., abc123)' },
                  subreddit: { type: 'string', description: 'Subreddit the post is in' },
                  limit: { type: 'integer', default: 20, maximum: 50 },
                  sort: { type: 'string', enum: ['top', 'best', 'new', 'controversial'], default: 'top' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Comments fetched' }, '400': { description: 'Invalid request' }, '502': { description: 'Reddit API error' } }
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

async function rateLimitedFetch(url) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow'
    });
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { error: `Reddit returned ${response.status}: ${text.substring(0, 200)}`, status: response.status };
    }

    const data = await response.json();
    return { data };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? 'Request timed out after 15s' : err.message;
    return { error: msg };
  }
}

function extractPost(child) {
  const d = child.data;
  return {
    title: d.title || '',
    author: d.author || '[deleted]',
    score: d.score || 0,
    url: d.url || '',
    permalink: `https://www.reddit.com${d.permalink || ''}`,
    selftext: (d.selftext || '').substring(0, 5000),
    numComments: d.num_comments || 0,
    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
    subreddit: d.subreddit || '',
    postId: d.id || '',
    flair: d.link_flair_text || '',
    isNsfw: d.over_18 || false
  };
}

function extractComment(child, depth) {
  if (child.kind !== 't1') return null;
  const d = child.data;
  return {
    author: d.author || '[deleted]',
    score: d.score || 0,
    body: (d.body || '').substring(0, 3000),
    depth: depth || d.depth || 0,
    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
    commentId: d.id || ''
  };
}

function flattenComments(listing, maxComments) {
  const comments = [];
  if (!listing || !listing.data || !listing.data.children) return comments;

  function walk(children, depth) {
    for (const child of children) {
      if (comments.length >= maxComments) break;
      const c = extractComment(child, depth);
      if (c) comments.push(c);
      if (child.data && child.data.replies && child.data.replies.data) {
        walk(child.data.replies.data.children, depth + 1);
      }
    }
  }

  walk(listing.data.children, 0);
  return comments;
}

async function handlePosts(params) {
  const startTime = Date.now();
  const subreddit = params.subreddit;
  const sort = params.sort || 'hot';
  const limit = Math.min(params.limit || 10, 25);
  const timeframe = params.timeframe || 'week';

  if (!subreddit) return { status: 400, body: { success: false, error: 'Missing required field: subreddit' } };
  if (!/^[a-zA-Z0-9_]+$/.test(subreddit)) return { status: 400, body: { success: false, error: 'Invalid subreddit name' } };

  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.json?limit=${limit}&t=${timeframe}&raw_json=1`;
  const result = await rateLimitedFetch(url);

  if (result.error) return { status: 502, body: { success: false, error: result.error } };

  const posts = (result.data.data.children || []).map(extractPost);

  return {
    status: 200,
    body: {
      success: true,
      subreddit,
      sort,
      posts,
      metadata: { fetchedAt: new Date().toISOString(), durationMs: Date.now() - startTime, count: posts.length }
    }
  };
}

async function handleSearch(params) {
  const startTime = Date.now();
  const query = params.query;
  const subreddit = params.subreddit;
  const sort = params.sort || 'relevance';
  const limit = Math.min(params.limit || 10, 25);
  const timeframe = params.timeframe || 'year';

  if (!query) return { status: 400, body: { success: false, error: 'Missing required field: query' } };

  let url;
  if (subreddit) {
    if (!/^[a-zA-Z0-9_]+$/.test(subreddit)) return { status: 400, body: { success: false, error: 'Invalid subreddit name' } };
    url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${timeframe}&limit=${limit}&restrict_sr=on&raw_json=1`;
  } else {
    url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${timeframe}&limit=${limit}&raw_json=1`;
  }

  const result = await rateLimitedFetch(url);

  if (result.error) return { status: 502, body: { success: false, error: result.error } };

  const results = (result.data.data.children || []).map(extractPost);

  return {
    status: 200,
    body: {
      success: true,
      query,
      subreddit: subreddit || 'all',
      sort,
      results,
      metadata: { fetchedAt: new Date().toISOString(), durationMs: Date.now() - startTime, count: results.length }
    }
  };
}

async function handleComments(params) {
  const startTime = Date.now();
  const postId = params.postId;
  const subreddit = params.subreddit;
  const limit = Math.min(params.limit || 20, 50);
  const sort = params.sort || 'top';

  if (!postId) return { status: 400, body: { success: false, error: 'Missing required field: postId' } };
  if (!subreddit) return { status: 400, body: { success: false, error: 'Missing required field: subreddit' } };
  if (!/^[a-zA-Z0-9_]+$/.test(subreddit)) return { status: 400, body: { success: false, error: 'Invalid subreddit name' } };
  if (!/^[a-zA-Z0-9]+$/.test(postId)) return { status: 400, body: { success: false, error: 'Invalid postId' } };

  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}.json?sort=${sort}&limit=${limit}&raw_json=1`;
  const result = await rateLimitedFetch(url);

  if (result.error) return { status: 502, body: { success: false, error: result.error } };

  // Reddit returns [post_listing, comments_listing]
  const commentListing = Array.isArray(result.data) && result.data.length > 1 ? result.data[1] : null;
  const comments = flattenComments(commentListing, limit);

  // Also extract the post info
  const postListing = Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
  let post = null;
  if (postListing && postListing.data && postListing.data.children && postListing.data.children.length > 0) {
    post = extractPost(postListing.data.children[0]);
  }

  return {
    status: 200,
    body: {
      success: true,
      postId,
      subreddit,
      post,
      comments,
      metadata: { fetchedAt: new Date().toISOString(), durationMs: Date.now() - startTime, commentCount: comments.length }
    }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    return json(res, 200, { status: 'healthy', tool: 'agenticos-tool-reddit', timestamp: new Date().toISOString() });
  }

  if (req.url === '/openapi.json' && req.method === 'GET') {
    return json(res, 200, OPENAPI_SPEC);
  }

  if (req.method !== 'POST') {
    return json(res, 404, { error: 'Not found. Available endpoints: POST /posts, POST /search, POST /comments, GET /health, GET /openapi.json' });
  }

  let params;
  try {
    params = await readBody(req);
  } catch (_) {
    return json(res, 400, { success: false, error: 'Invalid JSON body' });
  }

  let result;
  if (req.url === '/posts') {
    result = await handlePosts(params);
  } else if (req.url === '/search') {
    result = await handleSearch(params);
  } else if (req.url === '/comments') {
    result = await handleComments(params);
  } else {
    return json(res, 404, { error: 'Not found. Available endpoints: POST /posts, POST /search, POST /comments, GET /health, GET /openapi.json' });
  }

  json(res, result.status, result.body);
});

server.listen(PORT, () => {
  console.log(`AgenticOS Reddit Tool listening on port ${PORT}`);
});
