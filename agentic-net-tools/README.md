# AgetnticOS Tool Images

User-space tool containers that AgetnticOS agents can discover, deploy, and use via HTTP transitions.

## Structure

```
agentic-net-tools/
├── build-and-push.sh                # Build all tools and push to local registry
├── agenticos-tool-echo/             # Demo echo server for testing
│   ├── Dockerfile
│   └── server.js
├── agenticos-tool-crawler/          # Web crawler with REST API
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── agenticos-tool-rss/              # RSS/Atom feed reader
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
└── agenticos-tool-search/           # Web search via DuckDuckGo HTML
    ├── Dockerfile
    ├── package.json
    └── server.js
```

## Tool Summary

| Tool | Port (host) | Endpoint | Description |
|------|-------------|----------|-------------|
| `agenticos-tool-echo` | — | `POST /*` | Demo echo server for testing |
| `agenticos-tool-crawler` | 8086 | `POST /crawl` | Crawls web pages, returns structured content |
| `agenticos-tool-rss` | 8087 | `POST /fetch` | Fetches RSS/Atom feeds, returns parsed items |
| `agenticos-tool-search` | 8088 | `POST /search` | Searches web via DuckDuckGo HTML scraping |

All tools listen on port **8080 internally**. Host ports above are for local dev (`docker run -p`).

## Label Convention

Every tool image must include these labels:

| Label | Example | Purpose |
|-------|---------|---------|
| `org.opencontainers.image.title` | `PDF Converter` | Human-readable name |
| `org.opencontainers.image.description` | `Converts documents to PDF` | What it does |
| `org.opencontainers.image.version` | `1.0.0` | Semver |
| `io.agenticos.tool.kind` | `api` | api / worker / function |
| `io.agenticos.tool.port` | `8080` | Primary service port |
| `io.agenticos.tool.health` | `/health` | Health check path |
| `io.agenticos.tool.openapi` | `/openapi.json` | OpenAPI spec endpoint |
| `io.agenticos.tool.capabilities` | `pdf,ocr,vectorize` | Comma-separated capabilities |

## Quick Start

```bash
# Start local registry (part of AgetnticOS docker-compose)
cd ../deployment
docker compose up -d agenticos-registry

# Build and push all tools
./build-and-push.sh

# Verify
curl http://localhost:5001/v2/_catalog
# {"repositories":["agenticos-tool-echo","agenticos-tool-crawler","agenticos-tool-rss","agenticos-tool-search"]}

# Browse via AgetnticOS API (requires master running with registry enabled)
curl http://localhost:8082/api/registry/images
```

## Agent Workflow

```
1. REGISTRY_LIST_IMAGES { search: "crawler" }
2. DOCKER_RUN { image: "localhost:5001/agenticos-tool-crawler:1.0.0", name: "crawler" }
3. HTTP_CALL or CREATE transition with baseUrl from step 2
4. DOCKER_STOP when done
```

## Contributing

1. Create a new directory: `agenticos-tool-<name>/`
2. Add a `Dockerfile` with all required labels (see Label Convention above)
3. Implement `/health` and `/openapi.json` endpoints
4. Add your tool's primary API endpoint(s)
5. Test locally: `docker build -t agenticos-tool-<name>:1.0.0 agenticos-tool-<name>/`
6. Push to registry: `./build-and-push.sh agenticos-tool-<name>`

### Guidelines

- Base image: `node:22-alpine` (Node.js) or equivalent minimal image
- Port: Always listen on `8080` internally
- Health: `/health` must return `{"status": "healthy"}` with 200
- OpenAPI: `/openapi.json` must describe all endpoints
- Keep images small: use alpine bases, multi-stage builds where appropriate
- No secrets in images: use environment variables for configuration
