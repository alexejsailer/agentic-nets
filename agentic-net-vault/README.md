# agentic-net-vault

Secrets service for transition credentials. Wraps [OpenBao](https://openbao.org/) (MPL-2.0 Vault fork) and exposes a small CRUD API scoped to `{modelId}/{transitionId}`.

**Port**: `8085` (HTTP)

## What it does

- Stores per-transition credentials so agent/HTTP transitions can interpolate `${credentials.API_TOKEN}` at execution time without leaking secrets into PNML or tokens.
- Reads/writes KV v2 at `secret/agenticos/credentials/{modelId}/{transitionId}`.
- Backend-agnostic: any Vault-API-compatible store works; default wiring is OpenBao.

## API

| Method | Path | Purpose |
|---|---|---|
| `PUT`    | `/api/vault/{modelId}/transitions/{transitionId}/credentials` | Upsert all creds |
| `GET`    | `/api/vault/{modelId}/transitions/{transitionId}/credentials` | Trusted master read (includes plaintext values; backend-network only) |
| `GET`    | `/api/vault/{modelId}/transitions/{transitionId}/credentials/metadata` | Read key names/version only |
| `DELETE` | `/api/vault/{modelId}/transitions/{transitionId}/credentials` | Delete all creds |

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `VAULT_OPENBAO_URL` | `http://localhost:8200` | OpenBao base URL |
| `VAULT_OPENBAO_TOKEN` | *(required)* | OpenBao auth token (dev mode) |
| `VAULT_KV_MOUNT` | `secret` | KV v2 mount path |
| `VAULT_APPROLE_ROLE_ID` | *(optional)* | AppRole auth (production) |
| `VAULT_APPROLE_SECRET_ID` | *(optional)* | AppRole auth (production) |
| `SERVER_TOMCAT_THREADS_MAX` | `25` | Worker ceiling; limits native-memory growth under a client storm |
| `SERVER_TOMCAT_MAX_CONNECTIONS` | `100` | Maximum accepted connections |
| `SERVER_TOMCAT_ACCEPT_COUNT` | `50` | Backlog after workers/connections are busy |

The master resolves credentials only immediately before a lane that may use them executes. Pure
lanes and status views do not depend on this service; a credential-dependent lane fails closed if
the vault or OpenBao is unavailable.

## Run

```bash
# Local (needs OpenBao running on :8200)
cd agentic-net-vault
VAULT_OPENBAO_TOKEN=dev-root-token ./mvnw spring-boot:run

# Docker (backend network only — not exposed to host)
docker run --rm \
  -e VAULT_OPENBAO_URL=http://openbao:8200 \
  -e VAULT_OPENBAO_TOKEN=dev-root-token \
  --network agenticnetos-backend \
  alexejsailer/agenticnetos-vault:2.1.8
```

## Health

```bash
curl http://localhost:8085/actuator/health
```
