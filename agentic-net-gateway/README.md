# agentic-net-gateway

OAuth2 / JWT API gateway for the AgenticNets backend. The only component that typically sits on a public network — all other services reach master, node, and vault through it.

**Port**: `8083` (HTTP)

## What it does

- Issues JWTs from an admin secret (bootstrap) and a readonly client credential.
- Relays traffic to three upstream services:
  - `master` (`/api/**`) — orchestration, agent sessions, transition lifecycle.
  - `node`   (`/node-api/**`) — event-sourced tree / ArcQL.
  - `vault`  (`/vault/**`) — transition credentials (OpenBao-backed).
- Long-poll friendly: proxy timeout defaults to 300 s so agent turns and streaming LLM calls don't drop.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `MASTER_URL` | `http://localhost:8082` | Upstream master base URL |
| `NODE_URL` | `http://localhost:8080` | Upstream node base URL |
| `VAULT_URL` | `http://localhost:8085` | Upstream vault base URL |
| `GATEWAY_TIMEOUT` | `30` | Connect / read timeout (s) for non-proxy calls |
| `GATEWAY_PROXY_TIMEOUT` | `300` | Upstream proxy timeout (s) — match agent turn length |
| `AGENTICOS_ADMIN_SECRET` | *(generated on first start)* | Root credential used by CLI / executor / chat |
| `AGENTICOS_READONLY_SECRET` | *(optional)* | Readonly JWT scope for view-only integrations |

On first start the gateway writes its admin secret to `data/jwt/admin-secret` inside the container — mount that volume read-only in CLI / executor / chat so they auto-acquire tokens.

## Run

```bash
# Local (Maven)
cd agentic-net-gateway
./mvnw spring-boot:run

# Docker
docker run --rm -p 8083:8083 \
  -e MASTER_URL=http://agentic-net-master:8082 \
  -e NODE_URL=http://agentic-net-node:8080 \
  -v agenticnetos-gateway-data:/app/data \
  alexejsailer/agenticnetos-gateway:latest
```

## Health

```bash
curl http://localhost:8083/actuator/health
```
