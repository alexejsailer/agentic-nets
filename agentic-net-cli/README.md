# agentic-net-cli

Command-line front door for persona agents and Agentic-Nets. Create a developer, health coach,
domain expert, or complete specialist team; attach durable context; then let its Petri net provide
memory, hand-offs, schedules, audit history, and deterministic automation. The CLI drives the same
tool surface in-net agents use (QUERY_TOKENS, CREATE_TOKEN, DEPLOY_TRANSITION, INVOKE_TOOL_NET, …).

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
# Ask the builder to propose a persona-first solution, then create it
agenticos agent "Create a developer persona for this project with a charter, task inbox, durable context, reviewer hand-off, and a backend that works without a server LLM."

# Use Codex or Claude Code as the connected model provider
agenticos agent --provider codex "Design a health-coach persona with safe boundaries and a journal"
agenticos agent --provider claude-code "Install or compose a small developer/reviewer team"

# Inspect a specific transition
agenticos transition show t-orchestrator
```

Execution choices matter: with a server provider, ordinary `agent`/`llm` transitions run on master.
Without one, an agent inscription can use `llmMode:"bash"` plus `binary:"claude"|"codex"` and keep
its bounded agent loop unattended; a command transition is ideal for one-shot headless stdin→stdout
jobs. Local CLI execution remains an attended option. Always make the chosen backend visible.

## Config

`~/.agenticos/config.yaml`:
```yaml
default_provider: claude-code
thinking_model: opus
gateway_url: http://localhost:8083
```

See [../CHANGELOG.md](../CHANGELOG.md) for the current tool catalog (synced from master via `npm run sync-tools`).
