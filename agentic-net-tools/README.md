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
| `agenticos-tool-weather` | `GET /weather?city=<name>` | Deterministic mock weather API (demo + e2e smoke tests) |

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

## Durable Tool Catalog

The OCI registry answers “which images exist”; the AgenticOS tool catalog answers
“which callable tools are known and what is their contract”. Catalog entries are
stored as tokens in the always-available `default` model, place
`p-tool-catalog`. Full OpenAPI documents are stored in Blobstore and referenced
by immutable URNs from the catalog token.

A coding agent connected through MCP builds on its own Docker host, pushes to
the bundled registry, and asks AgenticOS to validate/catalog the result:

```bash
docker build -t localhost:5001/agenticos-tool-example:1.0.0 ./example
docker push localhost:5001/agenticos-tool-example:1.0.0
```

```json
TOOL_CATALOG_IMPORT_IMAGE {
  "image": "localhost:5001/agenticos-tool-example:1.0.0",
  "id": "example"
}
```

Import accepts only the configured local registry. The master starts a temporary
validation container, checks the declared OpenAPI document, stores the spec in
Blobstore, records the registry digest, and writes an approved catalog entry. It
does not build images. Search with `TOOL_CATALOG_SEARCH`; inspect the contract and
binding with `TOOL_CATALOG_GET`.

The catalog upserts by id: re-importing the same id replaces the previous entry
(one entry per tool). The pinned digest is enforced at run time — once an image
ref is cataloged, starting it requires the registry digest to still match, so a
re-pushed tag must be re-imported before it runs again. Uncataloged images are
unaffected and remain governed by the image allowlist alone.

External services can be described without a Docker image using
`TOOL_CATALOG_REGISTER_HTTP` with `baseUrl` plus inline `openapi` or an
`openapiUrl`. HTTP entries are stored with status `registered` — they are not
container-validated, so they never claim `approved`.

### Script tools

The third binding type covers executable scripts (node / sh / bash / python3)
that run on the executor — the pattern behind the forum automation lanes.
Register once with `TOOL_CATALOG_REGISTER_SCRIPT` (content is stored in
Blobstore, pinned by its sha256), then invoke from any command transition:

```json
{"executor": "script", "command": "invoke",
 "args": {"toolId": "forum-sentinel", "argv": [], "env": {"KEY": "..."}, "timeoutMs": 110000}}
```

At FIRE time the master resolves `toolId` against the catalog, verifies the
blob against the pinned digest, and inlines the content into the shipped
token — executors never need blob access, so egress-only gateway deployments
keep working. The executor re-verifies the digest and runs the script from a
content-addressed cache in the persistent `/workspace` volume. Compared to
copying files into the container (`docker cp ... /opt/`): the artifact
survives container recreation, is versioned and auditable in the catalog, and
content that doesn't hash to the registered digest is refused end to end.

## Portable packages (NetHub)

Publishing a net used to ship only pointers: an inscription referenced a script
by `scriptUrn` + sha256, a docker tool by image digest, an OpenAPI contract by
`specUrn` — but the catalog entries and their blobs stayed behind, so a net that
used any tool installed onto another instance as a dangling pointer and did not
run. NetHub packages are now **self-contained**: `hub_publish` scans the
artifact's inscriptions for every referenced `toolId`, `action.image`, and
`urn:agenticos:blob:*`, resolves the matching catalog entries (local catalog
first, then global), and bundles them together with the blobs they point at
(each carried as base64 + its sha256).

On `hub_install` the bundled dependencies are re-materialized on the receiving
instance before the net structure lands: the package's integrity hash is
verified, every blob's sha256 is re-checked and uploaded to the local blobstore
(content-addressed, so the id is identical on every instance and the
inscription's URN still resolves), and each catalog entry is registered into the
correct **scope** — docker/http entries into the shared `default` catalog,
script/tool-net entries into the installed model's own `p-tool-catalog`. Content
that does not hash to its pinned digest is refused, the same discipline the
executor enforces at run time.

Beyond `net`/`session`/`model`, `hub_publish` accepts four dependency-aware
kinds:

| kind | publishes | installs into |
|------|-----------|---------------|
| `toolnet` | one tool-net (net + inscriptions + manifest) + its tool deps | re-scaffolded net + manifest re-registered (local) |
| `tool` | one catalog tool (docker/http/script) + its blob(s) | its scope (global for docker/http, local for script) |
| `catalog` | a whole catalog (`catalogScope` global or a model's local) + all blobs | merged into the target scope |
| `blob` | raw blobs by `blobUrns` | uploaded to the target blobstore |

Package payloads are stored content-addressed in blobstore (not as a node leaf),
so they carry their bundled blobs without a size ceiling and each package has a
verifiable content hash.

## Contributing

1. Create a new directory: `agenticos-tool-<name>/`
2. Add a `Dockerfile` with all required labels (see Label Convention above)
3. Implement `/health` and `/openapi.json` endpoints
4. Add your tool's primary API endpoint(s)
5. **Add the tool to `tools.txt`** — the single source of truth consumed by the
   seeder and all CI build/push/promote scripts
6. Test locally: `docker build -t agenticos-tool-<name>:1.0.0 agenticos-tool-<name>/`
7. Push to registry: `./build-and-push.sh agenticos-tool-<name>`

### Guidelines

- Base image: `node:22-alpine` (Node.js) or equivalent minimal image
- Port: Always listen on `8080` internally
- Health: `/health` must return `{"status": "healthy"}` with 200
- OpenAPI: `/openapi.json` must describe all endpoints
- Keep images small: use alpine bases, multi-stage builds where appropriate
- No secrets in images: use environment variables for configuration
