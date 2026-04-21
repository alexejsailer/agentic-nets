# AgenticNetOS Tool Images

User-space tool containers that AgenticNetOS agents can discover, deploy, and use via HTTP transitions.

Released tool images are published to Docker Hub as `alexejsailer/agenticos-tool-*:<version>`. A local Agentic-Nets deployment mirrors approved images into its bundled registry (`localhost:5001`) before agents can run them. This keeps the runtime allowlist narrow: agents start only curated `localhost:5001/agenticos-*` images, not arbitrary public Docker Hub images.

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
├── agenticos-tool-reddit/           # Reddit JSON API integration
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── agenticos-tool-rss/              # RSS/Atom feed reader
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── agenticos-tool-search/           # Web search via DuckDuckGo HTML
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
└── agenticos-tool-secured-api/      # Test API-key protected endpoint
    ├── Dockerfile
    └── server.js
```

## Tool Summary

| Tool | Endpoint | Description |
|------|----------|-------------|
| `agenticos-tool-echo` | `POST /*` | Echoes request data for smoke tests and debugging |
| `agenticos-tool-crawler` | `POST /crawl` | Crawls web pages and extracts structured content |
| `agenticos-tool-reddit` | `POST /posts`, `POST /search`, `POST /comments` | Fetches Reddit posts, comments, and search results |
| `agenticos-tool-rss` | `POST /fetch` | Fetches and parses RSS/Atom feeds |
| `agenticos-tool-search` | `POST /search` | Searches the web via DuckDuckGo HTML scraping |
| `agenticos-tool-secured-api` | `POST /data` | Validates `X-API-Key` and returns secured test data |

All tools listen on port **8080 internally**. Host ports are chosen when you run them, either manually with `docker run -p` or via the AgenticOS tools panel, which allocates dynamic host ports.

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
# Start the Agentic-Nets stack and local registry
cd ../deployment
docker compose -f docker-compose.hub-only.yml up -d

# Mirror the released tool images into the local registry
docker compose -f docker-compose.hub-only.yml --profile tools run --rm agenticos-tool-seeder

# Verify
curl http://localhost:5001/v2/_catalog
# {"repositories":["agenticos-tool-crawler","agenticos-tool-echo","agenticos-tool-reddit","agenticos-tool-rss","agenticos-tool-search","agenticos-tool-secured-api"]}

# Browse via AgenticNetOS API (requires master running with registry enabled)
curl http://localhost:8082/api/registry/images
```

For local tool development, build from this directory instead of mirroring Docker Hub:

```bash
cd ../deployment
AGENTICOS_TOOL_SEED_MODE=build docker compose -f docker-compose.yml --profile tools run --rm agenticos-tool-seeder
```

The lower-level builder script is still useful when you want direct control:

```bash
REGISTRY=localhost:5001 ./build-and-push.sh
REGISTRY=docker.io/alexejsailer ./build-and-push.sh 2.1.8
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
