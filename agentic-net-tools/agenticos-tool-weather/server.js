const http = require('http');

const PORT = process.env.PORT || 8080;

// Deterministic mock weather so E2E tests are stable: derive values from the
// city name. No external calls — this is a self-contained REST API in a container.
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return h;
}

const CONDITIONS = ['sunny', 'partly cloudy', 'cloudy', 'light rain', 'rain', 'thunderstorm', 'snow', 'fog'];

function weatherFor(city) {
  const h = hash(city.toLowerCase().trim());
  const tempC = (h % 41) - 5;            // -5..35
  const condition = CONDITIONS[h % CONDITIONS.length];
  const humidity = 30 + (h % 60);        // 30..89
  const windKph = h % 40;                // 0..39
  return {
    city,
    tempC,
    condition,
    humidity,
    windKph,
    unit: 'metric',
    source: 'agenticos-tool-weather (deterministic mock)',
    timestamp: new Date().toISOString(),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (url.pathname === '/health') {
    return json(200, { status: 'healthy', tool: 'agenticos-tool-weather', timestamp: new Date().toISOString() });
  }

  if (url.pathname === '/openapi.json') {
    return json(200, {
      openapi: '3.0.0',
      info: { title: 'AgenticOS Weather Tool', version: '1.0.0', description: 'Deterministic mock current-weather API for a city' },
      paths: {
        '/weather': {
          get: {
            summary: 'Get current weather for a city',
            parameters: [{ name: 'city', in: 'query', required: true, schema: { type: 'string' }, description: 'City name' }],
            responses: { '200': { description: 'Current weather', content: { 'application/json': { schema: { type: 'object', properties: {
              city: { type: 'string' }, tempC: { type: 'integer' }, condition: { type: 'string' },
              humidity: { type: 'integer' }, windKph: { type: 'integer' } } } } } } }
          }
        },
        '/health': { get: { summary: 'Health check', responses: { '200': { description: 'Healthy' } } } }
      }
    });
  }

  if (url.pathname === '/weather') {
    const city = url.searchParams.get('city');
    if (!city) return json(400, { error: 'missing required query param: city', example: '/weather?city=Berlin' });
    return json(200, weatherFor(city));
  }

  return json(404, { error: 'not found', endpoints: ['/weather?city=<name>', '/health', '/openapi.json'] });
});

server.listen(PORT, () => {
  console.log(`AgenticOS Weather Tool listening on port ${PORT}`);
});
