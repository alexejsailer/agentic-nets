# agentic-net-chat

Telegram front-end for AgenticNets. Wraps the CLI agent loop so a Telegram chat becomes a live, multi-turn agent session — each chat gets its own isolated session, conversation history, and tool audit trail.

## What it does

- Bridges Telegram ⇄ the same agent runtime the CLI uses (`@agenticos/cli` via workspace dep).
- Streams tool-call batches back to Telegram in near real time (batched every 3 calls).
- `/verbose` toggle per chat: turn the tool-call stream on/off without touching config.
- Auto-compacts conversation history above a token threshold so long chats don't blow past context limits.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_ENABLED` | `false` | Gate — set `true` to start polling |
| `TELEGRAM_BOT_TOKEN` | *(required when enabled)* | BotFather token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | *(optional)* | Comma-separated allowlist |
| `AGENTICOS_GATEWAY_URL` | `http://localhost:8083` | Gateway to route agent calls through |
| `AGENTICOS_PROVIDER` | `claude-code` | LLM provider (see CLI README) |
| `CHAT_SESSION_TTL_MINUTES` | `240` | Idle TTL before a chat session expires |
| `CHAT_COMPACT_THRESHOLD_TOKENS` | `30000` | Compaction trigger |
| `VERBOSE_BATCH_SIZE` | `3` | Tool-call batch size for streaming updates |

## Run

```bash
# Local
cd agentic-net-chat
npm install && npx tsup
TELEGRAM_BOT_ENABLED=true TELEGRAM_BOT_TOKEN=... node dist/bin/chat.js

# Docker — build context must be repo root (depends on ../agentic-net-cli)
docker run --rm \
  -e TELEGRAM_BOT_ENABLED=true \
  -e TELEGRAM_BOT_TOKEN=... \
  -v agenticnetos-gateway-data:/app/gateway-data:ro \
  alexejsailer/agenticnetos-chat:latest
```

## Built-in chat commands

| Command | Effect |
|---|---|
| `/clear` | Wipe current chat session |
| `/verbose` | Toggle live tool-call streaming |
| `/help`   | List available commands |

## Limits

- 100 iterations / turn · 100 tool calls / turn · 3 THINK calls / turn · 50 consecutive same-tool calls (loop guard).
