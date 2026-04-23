# Post-Deployment Configuration

After deploying Agentic-Nets, you can configure API keys, LLM providers, model tiers,
Telegram bot settings, and local Ollama access by editing the `.env` file and
restarting the affected services.

## How Configuration Works

Docker Compose reads the `.env` file at startup and injects values into containers.
**Changes to `.env` only take effect after restarting services.**

```bash
# Edit the .env file
nano .env

# Restart affected services (chat + master pick up LLM changes)
docker compose down && docker compose up -d

# Or restart only specific services (faster)
docker compose restart agentic-net-chat agentic-net-master
```

> **Note**: `docker compose restart` re-creates containers with the same config.
> To pick up `.env` changes you must use `down` + `up`, or
> `docker compose up -d --force-recreate agentic-net-chat agentic-net-master`.

## LLM Provider Configuration

### Switching Providers

Set `LLM_PROVIDER` in `.env` to one of: `ollama`, `claude`, `openai`

```bash
LLM_PROVIDER=ollama        # Default — uses Ollama (local or cloud models)
LLM_PROVIDER=claude        # Anthropic Claude API
LLM_PROVIDER=openai        # OpenAI API
```

### Model Tiers

Each provider supports three model tiers. The default tier is `medium`.

```bash
AGENTICOS_MODEL_TIER=medium   # Options: high, medium, low
```

### Ollama Configuration

By default the compose stack bundles an Ollama container (`agenticnetos-ollama`)
and backend services reach it via the compose service name `ollama`:

```bash
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2
OLLAMA_HIGH_MODEL=llama3.2
OLLAMA_MEDIUM_MODEL=llama3.2
OLLAMA_LOW_MODEL=llama3.2
```

After the stack is up, pull your model into the bundled container:

```bash
docker exec agenticnetos-ollama ollama pull llama3.2
```

If you prefer to run Ollama on your host (e.g. for GPU acceleration), override
`OLLAMA_BASE_URL`: `http://host.docker.internal:11434` on Docker Desktop,
`http://172.17.0.1:11434` on Linux-native Docker.

Use a local model for first-run assistant work. Cloud models with the `:cloud`
suffix route through ollama.com and can be rate-limited during longer assistant
or builder sessions.

### Anthropic (Claude) Configuration

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_HIGH_MODEL=claude-opus-4-7
ANTHROPIC_MEDIUM_MODEL=claude-sonnet-4-6
ANTHROPIC_LOW_MODEL=claude-haiku-4-5-20251001
```

### OpenAI Configuration

```bash
OPENAI_API_KEY=sk-...
OPENAI_HIGH_MODEL=gpt-5.4
OPENAI_MEDIUM_MODEL=gpt-5.4-mini
OPENAI_LOW_MODEL=gpt-5.4-nano
```

### Applying LLM Changes

After editing any LLM settings in `.env`:

```bash
docker compose up -d --force-recreate agentic-net-master agentic-net-chat
```

The **master** service (Java) uses `LLM_PROVIDER`, the provider API key, `OLLAMA_BASE_URL`,
and `OLLAMA_MODEL` (single model, not tiered).

The **chat** service (TypeScript) uses all tier fields and supports per-user overrides
via Telegram commands (see below).

## Telegram Bot Configuration

### Initial Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token and username
3. Set these values in `.env`:

```bash
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_BOT_USERNAME=your_bot_username
```

4. Restart the chat service:

```bash
docker compose up -d --force-recreate agentic-net-chat
```

### Webhook Mode (for internet-facing deployments)

If your server has a public URL, configure webhook mode for better performance:

```bash
TELEGRAM_BOT_WEBHOOK_BASE_URL=https://your-domain.com
TELEGRAM_BOT_WEBHOOK_SECRET=a-random-secret-string
```

### Access Control

Restrict which Telegram chat IDs can use the bot:

```bash
# Comma-separated list of allowed chat IDs (leave empty to allow all)
TELEGRAM_BOT_ALLOWED_CHAT_IDS=123456789,987654321
```

To find your chat ID, send a message to the bot and check the logs:
```bash
docker compose logs agentic-net-chat | grep "chat.*id"
```

### Per-User Runtime Overrides (Telegram Commands)

Once the bot is running, users can switch providers and tiers without editing `.env`:

| Command | Description |
|---------|-------------|
| `/provider <name>` | Switch LLM provider (ollama, claude, openai) |
| `/model <tier>` | Switch model tier (high, medium, low) |
| `/setkey <provider> <key>` | Set API key for a provider (message auto-deleted) |
| `/config` | Show current provider, tier, and which keys are set |

These overrides are per-session and reset when the bot restarts.

## Optional Ollama Cloud Authentication

Local models are recommended for the first run. If you deliberately choose an
Ollama cloud model such as `gpt-oss:120b-cloud`, Ollama must be authenticated on
the host machine.

### Local Mac (Docker Desktop)

Docker Desktop uses `host.docker.internal` to reach the host's Ollama instance.

```bash
# On your Mac (not inside Docker)
ollama signin
# Enter your Ollama credentials when prompted

# Verify cloud models work
ollama run gpt-oss:120b-cloud "hello"
```

### Remote Linux Server (Staging/Production)

Ollama must be running as a systemd service and authenticated as the same user.

```bash
# 1. Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 2. Login (as the user running ollama)
ollama signin

# 3. Verify the service is running
systemctl status ollama

# 4. Test a cloud model
ollama run gpt-oss:120b-cloud "hello"
```

**Important**: If Ollama runs as a systemd service (typically as the `ollama` user),
you must login as that user:

```bash
sudo -u ollama ollama signin
```

If `ollama signin` stores credentials in `~/.ollama/`, make sure the systemd service
user has access to that path.

### Docker-to-Host Networking

On Linux servers, `host.docker.internal` may not resolve automatically. Add this
to the master/chat service in your compose file, or set the Ollama URL to the
host's IP:

```bash
# Option A: Use host IP directly
OLLAMA_BASE_URL=http://172.17.0.1:11434

# Option B: Use extra_hosts in your compose file
# extra_hosts:
#   - "host.docker.internal:host-gateway"
```

## Security Notes

### API Keys

- API keys in `.env` are passed as environment variables to containers
- They are visible via `docker inspect` — do not expose the Docker socket to untrusted users
- For production, consider using Docker secrets or an external secrets manager
- The `/setkey` Telegram command auto-deletes the user's message to avoid key exposure in chat history

### Admin Secret

The gateway auto-generates an admin secret on first startup and stores it at
`./data/gateway/jwt/admin-secret`. CLI and Chat mount this file read-only for
auto-authentication. Leave `AGENTICOS_ADMIN_SECRET` empty in `.env` so the
gateway manages the secret lifecycle.

### Grafana & OpenBao

Change these defaults before internet-facing deployment:

```bash
GRAFANA_ADMIN_PASSWORD=<strong-password>
OPENBAO_DEV_ROOT_TOKEN=<random-token>
```

## Quick Reference

### Minimal Setup (Ollama only, no API keys needed)

```bash
# .env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=llama3.2
OLLAMA_HIGH_MODEL=llama3.2
OLLAMA_MEDIUM_MODEL=llama3.2
OLLAMA_LOW_MODEL=llama3.2
```

### Claude Setup

```bash
# .env
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

### OpenAI Setup

```bash
# .env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

### Full Setup (all providers available for Telegram per-user switching)

```bash
# .env
LLM_PROVIDER=ollama
AGENTICOS_MODEL_TIER=medium
OLLAMA_BASE_URL=http://host.docker.internal:11434
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_BOT_USERNAME=your_bot
```

Then users can switch between providers at runtime via `/provider claude`, `/provider openai`, etc.
