# AgenticNet Executor

Command-only executor for AgenticNetOS transitions.

## Overview

AgenticNet Executor runs **command** transitions by polling agentic-net-master for work and executing
command tokens locally (bash, filesystem, mcp, etc.). It does **not** accept transition
registration or fire requests over HTTP. Only health and metrics endpoints are exposed.

Key capabilities:
- Polls master for assigned command transitions
- Executes command tokens locally
- Emits and consumes tokens via master APIs
- Outbound-only architecture (no inbound transition APIs)

## Architecture

```
┌──────────────────────────────┐
│  agentic-net-executor (8084)    │
│  - Poll master               │
│  - Execute command tokens    │
│  - Emit/consume via master   │
└──────────────┬───────────────┘
               │ outbound HTTP/WebSocket
               ▼
┌──────────────────────────────┐
│  agentic-net-master (8082)      │
│  - Assign transitions        │
│  - Bind tokens (ArcQL)        │
│  - Send FIRE commands         │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  agentic-net-node (8080)        │
│  - Token storage             │
└──────────────────────────────┘
```

## Quick Start

Prereqs:
- agentic-net-master running on 8082
- agentic-net-node running on 8080

Run executor:

```bash
cd agentic-net-executor
./mvnw spring-boot:run
```

Override master + executor identity:

```bash
MASTER_HOST=localhost EXECUTOR_ID=exec-1 EXECUTOR_MODEL_ID=default ./mvnw spring-boot:run
```

## Health & Metrics

```bash
curl http://localhost:8084/api/health
curl http://localhost:8084/api/health/detailed
curl http://localhost:8084/actuator/prometheus
```

## Configuration

Relevant properties (see `src/main/resources/application.properties`):
- `master.base.url`
- `executor.id`
- `executor.model.id`
- `executor.communication.mode` (POLLING, WEBSOCKET, HYBRID)
- `executor.command.*` (timeouts, filesystem safety)

### Encryption key for transition credentials

The executor reads the env var **`AGENTICOS_CREDENTIALS_KEY`** (AES-256) to
decrypt transition credentials injected at action time. The user-facing
`deployment/.env.template` exposes the same value under the name
**`AGENTICOS_SETTINGS_KEY`** — the compose files bridge it with
`AGENTICOS_CREDENTIALS_KEY: ${AGENTICOS_SETTINGS_KEY:-}` so one variable
configures both services.

When running the executor **outside** Docker Compose (e.g. `./mvnw
spring-boot:run`), export `AGENTICOS_CREDENTIALS_KEY` directly — the compose
bridge does not apply and the executor will fail to decrypt credentials if the
variable is missing. The same value must match what `agentic-net-master` uses;
otherwise decryption will silently fail.

## Notes

- Command transitions **must** set `action.type = "command"`.
- Executors are assigned via master: `POST /api/transitions/assign`.
- Manual `fireOnce` for command transitions is queued by master and delivered on the next poll.
