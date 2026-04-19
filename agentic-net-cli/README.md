# agentic-net-cli

Command-line agent for AgenticNets. Drives the same tool surface the in-net agent transitions use (QUERY_TOKENS, CREATE_TOKEN, DEPLOY_TRANSITION, INVOKE_TOOL_NET, …), so anything an in-net agent can do, you can do from a shell.

## Install & build

```bash
cd agentic-net-cli
npm install
npx tsup             # produces dist/bin/agenticos.js (~105 KB ESM)
npm link             # optional — global `agenticos` on PATH
```

Node ≥ 22, native ESM.

## Connection modes

| Mode | Targets | Use when |
|---|---|---|
| `--direct` | node:8080 + master:8082 | You're on the backend network |
| gateway (default) | :8083 with auto-acquired JWT | Remote / firewalled setup |

The CLI auto-acquires a JWT from the gateway admin-secret volume (`./data/gateway/jwt/admin-secret` mounted read-only in Docker).

## LLM providers

| Provider | Backend | Flag |
|---|---|---|
| `anthropic` | Anthropic API | `--provider anthropic` |
| `claude-code` | `claude -p` bash binary | `--provider claude-code` |
| `codex` | `codex exec` bash binary | `--provider codex` |
| `ollama` | Local Ollama or `*.cloud` models | `--provider ollama` |
| `routed` | Two-tier: `worker` → `thinker` after first THINK | `--provider routed` |

Routed mode uses `thinking_model` from `~/.agenticos/config.yaml` to pick the reasoning tier once the agent calls `THINK`. Bash providers inject an XML `<tool_call>` protocol preamble at the top of the system prompt since they have no native function-calling API.

## Quickstart

```bash
# One-shot agent turn (gateway mode, default provider)
agenticos agent "list the sessions in this workspace"

# Direct mode against local master/node
agenticos agent --direct --provider ollama "show me the running transitions"

# Inspect a specific transition
agenticos transition show t-orchestrator
```

## Config

`~/.agenticos/config.yaml`:
```yaml
default_provider: claude-code
thinking_model: opus
gateway_url: http://localhost:8083
```

See [../CHANGELOG.md](../CHANGELOG.md) for the current tool catalog (synced from master via `npm run sync-tools`).
