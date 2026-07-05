# AgenticNetOS + OpenCode quick-start

Run the latest [OpenCode](https://opencode.ai) already wired to an AgenticNetOS backend.
**No fork, no branding** — this just launches upstream OpenCode with an `opencode.json` that
registers the `agenticnets` MCP server (stdio) pointed at your gateway. OpenCode keeps all of
its own coding tools and gains the full AgenticNetOS surface: build/query nets, reuse
tool-nets, publish/install from NetHub, and `invoke_agent` to drive the platform agents (the
same ones the GUI's Universal Assistant uses).

## Prerequisites

- A running AgenticNetOS stack reachable via the gateway (default `http://localhost:8083`).
  See the repo root [`README.md`](../../README.md) / `deployment/`.
- A gateway client secret. Native dev writes it to
  `agentic-net-gateway/data/jwt/admin-secret`; compose writes it to
  `deployment/data/gateway/jwt/admin-secret`. The script auto-detects these.
- `node` + `npm` (to build/run the MCP server), and `curl` (to install OpenCode if absent).

## Use it

From this directory (or anywhere — it writes `opencode.json` into your current directory):

```bash
AGENTICOS_MODELS=my-memory ./start.sh
```

That will: install OpenCode if it is not already on your PATH, build the `agenticnets` MCP
server if needed, render an `opencode.json` in your working directory, and launch OpenCode.

### One-liner (from a checkout of this repo)

```bash
AGENTICOS_MODELS=my-memory bash agentic-nets/integrations/opencode/start.sh
```

## Configuration (environment)

| Variable | Meaning | Default |
|---|---|---|
| `AGENTICOS_MODELS` | **Required.** Model allowlist (comma-separated); first is the default. | — |
| `AGENTICOS_GATEWAY_URL` | Gateway base URL. | `http://localhost:8083` |
| `AGENTICOS_GATEWAY_SECRET_FILE` | Path to the gateway secret file (preferred — keeps the secret out of `opencode.json`). | auto-detected |
| `AGENTICOS_ADMIN_SECRET` | Gateway client secret inline (used if no file is found). | — |
| `AGENTICOS_MODE` | `rw` or `readonly` (readonly exposes only read tools). | `rw` |
| `AGENTICOS_SESSION` | Session name for MCP-created nets. | `opencode` |
| `OPENCODE_MODEL` | Optional. Set OpenCode's model, e.g. `anthropic/claude-sonnet-5`. | OpenCode's own config |

OpenCode uses **your** model/provider credentials (`opencode auth login`). This quick-start
does not choose or brand a model — it only connects OpenCode to the AgenticNetOS backend.

## What gets written

`opencode.json` in your working directory, registering one MCP server (`agenticnets`) and
pointing OpenCode at [`AGENTS.md`](AGENTS.md), which teaches the "crystallize what works into
tool-nets, delegate to `invoke_agent`, record decisions" discipline. See
[`opencode.template.json`](opencode.template.json) for the shape if you prefer to wire it by
hand into an existing project.

## Notes

- The MCP server is launched from this repo's `agentic-net-mcp` (built on first run). If you
  copy `start.sh` out of the repo, it falls back to `npx -y @agenticnets/mcp`.
- Secrets are read from a file or environment and passed to the MCP process; they are never
  printed. Prefer `AGENTICOS_GATEWAY_SECRET_FILE` over inlining the secret.
- `readonly` mode is a safe default for exploring someone else's stack: it exposes only the
  read tools and the gateway rejects mutations.
