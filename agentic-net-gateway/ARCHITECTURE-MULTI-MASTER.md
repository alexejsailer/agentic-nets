# Multi-Master Routing Architecture

## System Topology

```
                    ┌──────────────────────────────────────┐
                    │           API Gateway                │
                    │           (port 8083)                │
                    │                                      │
                    │  ┌────────────────────────────────┐  │
                    │  │      MasterRegistryService     │  │
                    │  │                                │  │
                    │  │  masters:                      │  │
                    │  │    master-1: [model-a, model-b]│  │
                    │  │    master-2: [*]               │  │
                    │  │                                │  │
                    │  │  modelToMaster:                │  │
                    │  │    model-a → master-1          │  │
                    │  │    model-b → master-1          │  │
                    │  │    model-c → master-2 (auto)   │  │
                    │  └────────────────────────────────┘  │
                    │                                      │
                    │  ┌────────────────────────────────┐  │
                    │  │     MasterProxyController      │  │
                    │  │                                │  │
                    │  │  Route by modelId:             │  │
                    │  │    1. Query param              │  │
                    │  │    2. JSON body field          │  │
                    │  │    3. Fallback: any master     │  │
                    │  │                                │  │
                    │  │  Fan-out endpoints:            │  │
                    │  │    /api/transitions/discover   │  │
                    │  │    /api/executors (no modelId) │  │
                    │  └────────────────────────────────┘  │
                    └────────────┬──────────┬───────────────┘
                                 │          │
               ┌─────────────────┘          └─────────────────┐
               ▼                                              ▼
    ┌─────────────────────┐                    ┌─────────────────────┐
    │     Master 1        │                    │     Master 2        │
    │     (port 8082)     │                    │     (port 8082)     │
    │                     │                    │                     │
    │  master.id=master-1 │                    │  master.id=master-2 │
    │  master.models=     │                    │  master.models=*    │
    │    model-a,model-b  │                    │                     │
    │                     │                    │                     │
    │  Transition Engine  │                    │  Transition Engine  │
    │  Token Binding      │                    │  Token Binding      │
    │  Executor Registry  │                    │  Executor Registry  │
    └──────────┬──────────┘                    └──────────┬──────────┘
               │                                          │
               │  poll via gateway                        │  poll via gateway
               │                                          │
    ┌──────────┴──────────┐                    ┌──────────┴──────────┐
    │    Executor 1       │                    │    Executor 2       │
    │    (port 8084)      │                    │    (port 8084)      │
    │                     │                    │                     │
    │  executor.models=   │                    │  executor.models=*  │
    │    model-a          │                    │                     │
    └─────────────────────┘                    └─────────────────────┘
```

## Components

### Gateway

**Role**: Single entry point for all external traffic. Routes requests to the correct master based on model declarations. Aggregates responses when multiple masters are involved.

**State**: In-memory master registry rebuilt from master registrations on startup. Stateless otherwise — no database, no persistent storage for routing.

**Port**: 8083 (only internet-facing service).

**Key classes**:
- `MasterRegistryService` — Master registry, model-to-master mapping, round-robin, eviction
- `MasterProxyController` — Reverse proxy with model-based routing and fan-out
- `MasterRegistrationController` — Internal API for master registration lifecycle
- `SecurityConfig` — JWT resource server; `/internal/*` endpoints are unprotected

### Master

**Role**: Orchestration engine. Manages transition lifecycle, token binding, LLM integration. Each master instance owns a set of models (or all models via wildcard). Registers with gateway on startup.

**State**: Reads/writes transition tree in agentic-net-node. In-memory executor presence registry. No local persistent state.

**Port**: 8082.

**Key classes**:
- `GatewayRegistrationService` — Registers with gateway, heartbeats, deregisters on shutdown
- `TransitionAssignmentService` — Assigns transitions, creates `masterNode` and `assignedAgent` leaves
- `ExecutorPollingController` — Poll/discover endpoints with `allowedModels` filtering
- `ExecutorRegistryService` — Tracks executor presence and model visibility

### Executor

**Role**: Executes command-type transitions. Polls gateway (or master directly) for work. Discovers assigned models, then polls each model separately.

**State**: In-memory transition store keyed by `modelId:transitionId`. No persistent state.

**Port**: 8084.

**Key classes**:
- `MasterPollingService` — Discovery + polling loop, lifecycle command processing
- `TransitionStore` — In-memory store of deployed transitions
- `TransitionOrchestrator` — Executes commands with bound tokens

---

## Data Flows

### Flow 1: Master Registration

Masters register with the gateway on startup. This is opt-in — a master without gateway registration works in single-master mode via the seed master mechanism.

```
Master                              Gateway
  │                                    │
  │  POST /internal/masters/register   │
  │  {                                 │
  │    "masterId": "master-1",         │
  │    "url": "http://master1:8082",   │
  │    "models": ["model-a","model-b"] │
  │  }                                 │
  │ ──────────────────────────────────>│
  │                                    │  Store in masters map
  │                                    │  Create modelToMaster entries:
  │                                    │    model-a → master-1
  │                                    │    model-b → master-1
  │  200 OK                            │
  │  {                                 │
  │    "status": "registered",         │
  │    "heartbeatIntervalSeconds": 15  │
  │  }                                 │
  │ <──────────────────────────────────│
  │                                    │
  │  (every 15s)                       │
  │  POST /internal/masters/heartbeat  │
  │  { "masterId": "master-1" }        │
  │ ──────────────────────────────────>│
  │                                    │  Update lastHeartbeat
  │  200 OK { "status": "ok" }         │
  │ <──────────────────────────────────│
  │                                    │
  │  (on shutdown)                     │
  │  DELETE /internal/masters/master-1 │
  │ ──────────────────────────────────>│
  │                                    │  Remove from maps
  │  200 OK { "status":"deregistered" }│
  │ <──────────────────────────────────│
```

**Trigger**: Master startup (`@PostConstruct`) when `master.gateway-registration.enabled=true`.

**Heartbeat interval**: Returned by gateway = `masterHeartbeatTtlSeconds / 4`. Default: 60/4 = 15 seconds.

**Eviction**: Gateway runs `evictStale()` every 10 seconds. Masters whose `lastHeartbeat` is older than `masterHeartbeatTtlSeconds` (default 60s) are removed. Seed masters are never evicted.

### Flow 2: Seed Master (Backward Compatibility)

When `gateway.master-url` is configured (the default), the gateway auto-registers a synthetic `seed-master` on startup. This ensures single-master deployments work without any registration protocol.

```
Gateway startup
  │
  │  @PostConstruct init()
  │  gateway.master-url = "http://localhost:8082"
  │
  │  register("seed-master", "http://localhost:8082", ["*"], seed=true)
  │
  │  Result:
  │    masters: { "seed-master": { url, models=["*"], seed=true } }
  │    modelToMaster: (empty — wildcard masters don't create explicit mappings)
  │
  │  All requests route to seed-master via wildcard resolution
```

**Key property**: Seed masters have `seed=true` and are never evicted, even without heartbeats. When explicit masters register, they take priority for their declared models. The seed master remains as wildcard fallback.

### Flow 3: Executor Discovery

Executors discover which models they're assigned to by calling the gateway's discover endpoint. The gateway fans out to all relevant masters and aggregates results.

```
Executor                   Gateway                        Master 1           Master 2
  │                           │                              │                  │
  │ GET /api/transitions/     │                              │                  │
  │   discover                │                              │                  │
  │   ?executorId=exec-1      │                              │                  │
  │   &allowedModels=*        │                              │                  │
  │ ─────────────────────────>│                              │                  │
  │                           │                              │                  │
  │                           │  Fan-out: mastersForModels(["*"])               │
  │                           │  Result: [master-1, master-2]                   │
  │                           │                              │                  │
  │                           │  GET /api/transitions/       │                  │
  │                           │    discover                  │                  │
  │                           │    ?executorId=exec-1        │                  │
  │                           │    &allowedModels=*          │                  │
  │                           │ ────────────────────────────>│                  │
  │                           │                              │                  │
  │                           │  GET /api/transitions/discover                  │
  │                           │    ?executorId=exec-1&allowedModels=*           │
  │                           │ ───────────────────────────────────────────────>│
  │                           │                              │                  │
  │                           │  { assignments: [            │                  │
  │                           │      {modelId:"model-a",     │                  │
  │                           │       transitionId:"t1"}     │                  │
  │                           │  ] }                         │                  │
  │                           │ <────────────────────────────│                  │
  │                           │                              │                  │
  │                           │  { assignments: [                               │
  │                           │      {modelId:"model-c",                        │
  │                           │       transitionId:"t2"}                        │
  │                           │  ] }                                            │
  │                           │ <───────────────────────────────────────────────│
  │                           │                              │                  │
  │                           │  Aggregate assignments                          │
  │                           │                              │                  │
  │ 200 OK                    │                              │                  │
  │ {                         │                              │                  │
  │   "executorId": "exec-1", │                              │                  │
  │   "assignments": [        │                              │                  │
  │     {"modelId":"model-a", │                              │                  │
  │      "transitionId":"t1"},│                              │                  │
  │     {"modelId":"model-c", │                              │                  │
  │      "transitionId":"t2"} │                              │                  │
  │   ]                       │                              │                  │
  │ }                         │                              │                  │
  │ <─────────────────────────│                              │                  │
```

**Interval**: Executor runs discovery every 30 seconds (initial delay 2 seconds).

**allowedModels filtering**: The master filters returned assignments by the executor's `allowedModels`. If `allowedModels=model-a`, only model-a assignments are returned.

### Flow 4: Executor Polling (Per Model)

After discovery, the executor polls each discovered model individually. The gateway routes each poll to the correct master based on modelId.

```
Executor                   Gateway                        Master 1
  │                           │                              │
  │ GET /api/transitions/poll │                              │
  │   ?modelId=model-a        │                              │
  │   &executorId=exec-1      │                              │
  │   &allowedModels=model-a  │                              │
  │   &deployed=t1            │                              │
  │ ─────────────────────────>│                              │
  │                           │                              │
  │                           │  extractModelId → "model-a"  │
  │                           │  resolveMasterForModel("model-a")
  │                           │  → master-1 (explicit mapping)
  │                           │                              │
  │                           │  Proxy to master-1           │
  │                           │ ────────────────────────────>│
  │                           │                              │
  │                           │                              │  Evaluate transitions
  │                           │                              │  Bind tokens (ArcQL)
  │                           │                              │  Generate commands
  │                           │                              │
  │                           │  200 OK                      │
  │                           │  { transitions: [...] }      │
  │                           │ <────────────────────────────│
  │                           │                              │
  │ 200 OK                    │                              │
  │ {                         │                              │
  │   "executorId": "exec-1", │                              │
  │   "modelId": "model-a",   │                              │
  │   "transitions": [        │                              │
  │     {                     │                              │
  │       "transitionId":"t1",│                              │
  │       "command": "FIRE",  │                              │
  │       "boundTokens":{...},│                              │
  │       "inscription":{...},│                              │
  │       "credentials":{...} │                              │
  │     }                     │                              │
  │   ]                       │                              │
  │ }                         │                              │
  │ <─────────────────────────│                              │
```

**Interval**: Executor polls every 2 seconds per model (initial delay 5 seconds).

**Routing**: The gateway extracts `modelId` from the query parameter and resolves the target master via `modelToMaster` map. No fan-out — poll goes to exactly one master.

### Flow 5: Transition Assignment

When a transition is assigned to an executor (via GUI or API), the master stores `masterNode` and `assignedAgent` leaves in the transition tree.

```
GUI/API                    Gateway                     Master
  │                           │                           │
  │ POST /api/transitions/    │                           │
  │   assign                  │                           │
  │ {                         │                           │
  │   "modelId": "model-a",  │                           │
  │   "transitionId": "t1",  │                           │
  │   "agentId": "exec-1",   │                           │
  │   "inscription": {...},   │                           │
  │   "credentials": {...}    │                           │
  │ }                         │                           │
  │ ─────────────────────────>│                           │
  │                           │  Extract modelId="model-a"│
  │                           │  Route to master-1        │
  │                           │ ─────────────────────────>│
  │                           │                           │
  │                           │                           │  Create/update tree:
  │                           │                           │  /transitions/t1/
  │                           │                           │    inscription  = {...}
  │                           │                           │    assignedAgent= "exec-1"
  │                           │                           │    masterNode   = "master-1"
  │                           │                           │    status       = "deployed"
  │                           │                           │    deployedAt   = <now>
  │                           │                           │    credentials  = <encrypted>
  │                           │                           │    metrics/
  │                           │                           │      successCount = 0
  │                           │                           │      failureCount = 0
  │                           │                           │
  │                           │  200 OK                   │
  │                           │ <─────────────────────────│
  │ 200 OK                    │                           │
  │ <─────────────────────────│                           │
```

**Transition tree structure** (stored in agentic-net-node):
```
/root/workspace/transitions/{transitionId}/
├── inscription      — TransitionInscription JSON (runtime config)
├── assignedAgent    — Executor ID (e.g., "exec-1")
├── masterNode       — Master ID that assigned this (e.g., "master-1")
├── status           — Lifecycle state
├── deployedAt       — ISO-8601 timestamp (enables FIRE commands)
├── error            — Error message (if status=error)
├── credentials      — Encrypted credential blob (legacy; vault preferred)
└── metrics/
    ├── successCount
    ├── failureCount
    └── lastSuccess
```

### Flow 6: Executor List Fan-Out

When the GUI requests available executors without a specific modelId, the gateway fans out to all masters and deduplicates.

```
GUI                        Gateway                     Master 1          Master 2
  │                           │                           │                  │
  │ GET /api/executors        │                           │                  │
  │   ?activeOnly=true        │                           │                  │
  │ ─────────────────────────>│                           │                  │
  │                           │  No modelId → fan out     │                  │
  │                           │                           │                  │
  │                           │  GET /api/executors       │                  │
  │                           │ ─────────────────────────>│                  │
  │                           │                           │                  │
  │                           │  GET /api/executors                          │
  │                           │ ────────────────────────────────────────────>│
  │                           │                           │                  │
  │                           │  [exec-1, exec-2]         │                  │
  │                           │ <─────────────────────────│                  │
  │                           │                           │                  │
  │                           │  [exec-1, exec-3]                            │
  │                           │ <────────────────────────────────────────────│
  │                           │                           │                  │
  │                           │  Deduplicate by executorId                   │
  │                           │  [exec-1, exec-2, exec-3]                    │
  │                           │                           │                  │
  │ 200 OK                    │                           │                  │
  │ [exec-1, exec-2, exec-3]  │                           │                  │
  │ <─────────────────────────│                           │                  │
```

When a `modelId` IS provided, the gateway routes to the single master that owns that model (no fan-out).

---

## State Machines

### Master Lifecycle (Gateway Perspective)

```
                   register()
    ┌───────────┐ ───────────> ┌───────────┐
    │UNREGISTERED│              │  ACTIVE   │
    └───────────┘ <─────────── └─────┬─────┘
                   evictStale()      │  heartbeat()
                   (TTL expired)     │  ───────────>  ┌───────────┐
                                     └────────────────│  ACTIVE   │
                                                      │ (renewed) │
                                     ┌────────────────└───────────┘
                   deregister()      │
    ┌───────────┐ <──────────────────┘
    │UNREGISTERED│
    └───────────┘
```

**States**:
- **UNREGISTERED**: Master not in gateway registry. No requests routed to it.
- **ACTIVE**: Master registered and heartbeating. Receives routed requests.

**Transitions**:
- `register(masterId, url, models)` → ACTIVE. Creates model-to-master mappings.
- `heartbeat(masterId)` → ACTIVE (renewed). Updates `lastHeartbeat` timestamp.
- `evictStale()` → UNREGISTERED. Triggered when `lastHeartbeat < now - TTL`. Removes model mappings.
- `deregister(masterId)` → UNREGISTERED. Removes master and model mappings immediately.

**Exception**: Seed masters never transition to UNREGISTERED via eviction.

### Model Routing (Gateway Perspective)

```
    Unknown modelId
         │
         ▼
    ┌───────────────────────┐
    │ Check modelToMaster   │
    │ (explicit mapping)    │
    └───────────┬───────────┘
                │
         ┌──────┴──────┐
         │ Found?      │
         └──────┬──────┘
          Yes   │   No
          │     │
          ▼     ▼
    ┌─────────┐ ┌──────────────────┐
    │ Return  │ │ Find wildcard    │
    │ master  │ │ masters          │
    └─────────┘ └────────┬─────────┘
                         │
                  ┌──────┴──────┐
                  │ Any found?  │
                  └──────┬──────┘
                   Yes   │   No
                   │     │
                   ▼     ▼
             ┌───────────┐ ┌──────────────┐
             │ Round-     │ │ Any master   │
             │ robin      │ │ available?   │
             │ select +   │ │              │
             │ cache      │ │  Yes → return│
             └───────────┘ │  No  → throw │
                           └──────────────┘
```

**Round-robin assignment**: When a modelId has no explicit mapping, the gateway picks the next wildcard master via `counter.getAndIncrement() % wildcardMasters.size()`. The mapping is cached in `modelToMaster` so the same modelId always routes to the same master until that master is evicted.

### Transition Lifecycle (Master Perspective)

```
    ┌─────────────┐   DEPLOY    ┌──────────┐
    │ undeployed  │ ──────────> │ deployed │
    └─────────────┘             └────┬─────┘
                                     │
                              START  │
                                     ▼
                               ┌──────────┐
                               │ starting │
                               └────┬─────┘
                                    │
                             (auto) │
                                    ▼
         STOP              ┌──────────┐
    ┌────────────────────── │ running  │
    │                       └────┬─────┘
    │                            │
    │                     error  │
    ▼                            ▼
┌──────────┐  RESTART    ┌──────────┐
│ stopped  │ <────────── │  error   │
└──────────┘             └──────────┘
    │
    │  START
    ▼
┌──────────┐
│ starting │  (re-enters running)
└──────────┘
```

**Lifecycle commands** sent from master to executor via poll response:

| Command | Meaning | When Sent |
|---------|---------|-----------|
| `DEPLOY` | Deploy transition (executor parses inscription) | Status is `undeployed` or `deployed` but executor lost it |
| `START` | Start stopped transition | Status is `starting` |
| `STOP` | Stop running transition | Explicit stop request |
| `RESTART` | Restart errored transition | Status is `error` |
| `UPDATE` | Reload inscription | Inscription changed |
| `DELETE` | Remove transition | Status is `removing` or `removed` |
| `FIRE` | Execute with bound tokens | All preset tokens available and reserved |
| `CONTINUE` | No action, poll again | Normal idle state or waiting for tokens |

### Executor Polling Lifecycle

```
    ┌───────────────────────────────────────────────┐
    │              Executor Startup                  │
    └───────────────────────┬───────────────────────┘
                            │
                            ▼
    ┌───────────────────────────────────────────────┐
    │  Phase 1: Discovery (every 30s)               │
    │                                               │
    │  GET /api/transitions/discover                │
    │    ?executorId=<id>&allowedModels=<models>     │
    │                                               │
    │  Result: Set<modelId> (discoveredModelIds)     │
    └───────────────────────┬───────────────────────┘
                            │
                            ▼
    ┌───────────────────────────────────────────────┐
    │  Phase 2: Per-Model Polling (every 2s)        │
    │                                               │
    │  For each modelId in discoveredModelIds:      │
    │    GET /api/transitions/poll                  │
    │      ?modelId=<id>&executorId=<id>            │
    │      &allowedModels=<models>&deployed=<ids>    │
    │                                               │
    │  Result: List<TransitionWithCommand>           │
    └───────────────────────┬───────────────────────┘
                            │
                            ▼
    ┌───────────────────────────────────────────────┐
    │  Phase 3: Command Processing                  │
    │                                               │
    │  For each transition:                         │
    │    switch(command):                            │
    │      DEPLOY  → register in store              │
    │      START   → mark running                   │
    │      FIRE    → execute with boundTokens       │
    │      STOP    → mark stopped                   │
    │      DELETE  → remove from store              │
    │      CONTINUE→ no-op                          │
    └───────────────────────┬───────────────────────┘
                            │
                            ▼
    ┌───────────────────────────────────────────────┐
    │  Phase 4: Report Back                         │
    │                                               │
    │  POST /api/transitions/{id}/deployment        │
    │  { modelId, executorId, status, deployedAt }  │
    │                                               │
    │  POST /api/transitions/tokens/emit            │
    │  POST /api/transitions/tokens/consume          │
    └───────────────────────────────────────────────┘
```

---

## REST API Reference

### Gateway — Internal Registration API

Base path: `/internal/masters` (no JWT required).

| Method | Path | Request Body | Response | Description |
|--------|------|--------------|----------|-------------|
| POST | `/internal/masters/register` | `{ masterId: string, url: string, models: string[] }` | `{ status: "registered", heartbeatIntervalSeconds: number }` | Register or re-register a master |
| POST | `/internal/masters/heartbeat` | `{ masterId: string }` | `{ status: "ok" }` | Refresh master liveness |
| DELETE | `/internal/masters/{masterId}` | — | `{ status: "deregistered" }` | Remove master from registry |
| GET | `/internal/masters` | — | `MasterNode[]` | List all registered masters |

**MasterNode schema**:
```json
{
  "masterId": "master-1",
  "url": "http://master1:8082",
  "models": ["model-a", "model-b"],
  "registeredAt": "2025-01-15T10:00:00Z",
  "lastHeartbeat": "2025-01-15T10:05:00Z",
  "seed": false
}
```

### Gateway — Proxied API Endpoints (JWT required)

All `/api/**` requests are proxied to the appropriate master. The gateway adds no new endpoints — it transparently forwards.

| Method | Path | Routing | Behavior |
|--------|------|---------|----------|
| GET | `/api/transitions/discover` | Fan-out to all relevant masters | Aggregates `assignments` arrays |
| GET | `/api/transitions/poll` | Single master (by `modelId`) | Direct proxy |
| POST | `/api/transitions/assign` | Single master (by `modelId` in body) | Direct proxy |
| POST | `/api/transitions/{id}/start` | Single master (by `modelId`) | Direct proxy |
| POST | `/api/transitions/{id}/stop` | Single master (by `modelId`) | Direct proxy |
| GET | `/api/executors` (no modelId) | Fan-out to all masters | Deduplicates by `executorId` |
| GET | `/api/executors` (with modelId) | Single master | Direct proxy |
| * | `/api/**` (any other) | Single master (by modelId or fallback) | Direct proxy |

### Master — Executor Polling API

| Method | Path | Params | Response |
|--------|------|--------|----------|
| GET | `/api/transitions/discover` | `executorId`, `allowedModels` (optional) | `{ executorId, assignments: [{ modelId, transitionId }] }` |
| GET | `/api/transitions/poll` | `executorId`, `modelId`, `allowedModels` (optional), `deployed` (optional) | `{ executorId, modelId, polledAt, transitionCount, transitions: [TransitionWithCommand] }` |
| POST | `/api/transitions/assign` | Body: `{ modelId, transitionId, agentId, inscription, credentials }` | Assignment result |
| POST | `/api/transitions/{id}/start` | Body: `{ modelId }` | Status update |
| POST | `/api/transitions/{id}/stop` | Body: `{ modelId }` | Status update |
| GET | `/api/executors` | `activeOnly`, `modelId` (optional) | `ExecutorRegistryEntry[]` |

**TransitionWithCommand schema**:
```json
{
  "transitionId": "transition_process",
  "assignedAgent": "exec-1",
  "status": "running",
  "command": "FIRE",
  "inscription": { "action": { "type": "command", ... } },
  "deployedAt": "2025-01-15T10:25:00Z",
  "error": null,
  "metrics": { "successCount": 5, "failureCount": 0 },
  "credentials": { "API_KEY": "..." },
  "boundTokens": {
    "input": [{ "id": "token-123", "properties": {...}, "_parentPlace": "place-uuid" }]
  },
  "ready": true
}
```

---

## Model-Based Routing Rules

### modelId Extraction (Gateway)

The gateway extracts `modelId` from requests in this order:

1. **Query parameter** `modelId` — checked first, used if non-blank
2. **JSON body field** `modelId` — parsed from request body if present
3. **null** — triggers fallback resolution

### Routing Decision Table

| modelId | Explicit mapping exists? | Wildcard masters exist? | Action |
|---------|--------------------------|-------------------------|--------|
| `"model-a"` | Yes (→ master-1) | — | Route to master-1 |
| `"model-a"` | No | Yes | Round-robin assign to wildcard, cache mapping |
| `"model-a"` | No | No | Route to any available master |
| `null` | — | Yes | Route to next wildcard (round-robin, no caching) |
| `null` | — | No | Route to any available master |
| Any | — | — (no masters) | 502 Bad Gateway |

### Fan-Out Decision Table

| Endpoint | modelId present? | Action |
|----------|------------------|--------|
| `/api/transitions/discover` | Ignored | Always fan-out to masters matching `allowedModels` |
| `/api/executors` | No | Fan-out to all masters, deduplicate |
| `/api/executors` | Yes | Route to single master owning that model |
| Everything else | Yes | Route to single master |
| Everything else | No | Route to fallback master |

### allowedModels Filtering (Master)

When the master receives a discover or poll request with `allowedModels`:

- `allowedModels=*` or absent → return all assignments/executors
- `allowedModels=model-a,model-b` → filter to only those models

When listing executors with a `modelId` filter:

- Executor visible if `allowedModels` is empty, contains `*`, or contains the queried `modelId`
- Otherwise executor is hidden from that model's executor list

---

## Configuration Reference

### Gateway (`agentic-net-gateway`)

| Property | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `gateway.master-url` | `MASTER_URL` | `http://localhost:8082` | Seed master URL. Empty = no seed master |
| `gateway.master-heartbeat-ttl-seconds` | `GATEWAY_MASTER_HEARTBEAT_TTL` | `60` | TTL before evicting stale masters |
| `gateway.proxy-fan-out-timeout-seconds` | `GATEWAY_FAN_OUT_TIMEOUT` | `30` | Per-request timeout during fan-out |
| `gateway.proxy-timeout-seconds` | `GATEWAY_PROXY_TIMEOUT` | `300` | Single-request proxy timeout (long for LLM) |

### Master (`agentic-net-master`)

| Property | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `master.id` | `MASTER_ID` | `master-default` | Unique master identifier |
| `master.models` | `MASTER_MODELS` | `*` | Comma-separated models or `*` for wildcard |
| `master.gateway-registration.enabled` | `MASTER_GATEWAY_REGISTRATION` | `false` | Enable gateway registration |
| `master.gateway-registration.gateway-url` | `MASTER_GATEWAY_URL` | (empty) | Gateway base URL |
| `master.gateway-registration.self-url` | `MASTER_SELF_URL` | `http://localhost:8082` | URL gateway should use to reach this master |
| `master.gateway-registration.heartbeat-interval-seconds` | `MASTER_HEARTBEAT_INTERVAL` | `15` | Heartbeat frequency |

### Executor (`agentic-net-executor`)

| Property | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `executor.id` | `EXECUTOR_ID` | `agentic-net-executor-default` | Unique executor identifier |
| `executor.models` | `EXECUTOR_MODELS` | `*` | Models this executor handles. Comma-separated or `*` |
| `executor.upstream.url` | `EXECUTOR_UPSTREAM_URL` | `http://localhost:8082` | Gateway or master URL to poll |
| `executor.upstream.auth.client-id` | `EXECUTOR_AUTH_CLIENT_ID` | (empty) | JWT client ID (needed for gateway mode) |
| `executor.upstream.auth.client-secret` | `EXECUTOR_AUTH_CLIENT_SECRET` | (empty) | JWT client secret (needed for gateway mode) |

---

## Deployment Topologies

### Topology 1: Single Master (Default)

No configuration changes needed. Backward compatible.

```
Gateway (8083)  ──seed-master──>  Master (8082)  <──poll──  Executor (8084)
```

- `gateway.master-url=http://master:8082` (default)
- `master.gateway-registration.enabled=false` (default)
- Seed master auto-registered as wildcard
- All requests route to the single master

### Topology 2: Multi-Master with Explicit Models

Each master declares specific models. Unknown models go to wildcard masters via round-robin.

```yaml
# Master 1 — handles user-leo and user-alice models
MASTER_ID=master-1
MASTER_MODELS=user-leo,user-alice
MASTER_GATEWAY_REGISTRATION=true
MASTER_GATEWAY_URL=http://gateway:8083
MASTER_SELF_URL=http://master1:8082

# Master 2 — wildcard, handles everything else
MASTER_ID=master-2
MASTER_MODELS=*
MASTER_GATEWAY_REGISTRATION=true
MASTER_GATEWAY_URL=http://gateway:8083
MASTER_SELF_URL=http://master2:8082

# Gateway — no seed master (masters register themselves)
MASTER_URL=

# Executor — handles all models via gateway
EXECUTOR_UPSTREAM_URL=http://gateway:8083
EXECUTOR_MODELS=*
EXECUTOR_AUTH_CLIENT_ID=executor-client
EXECUTOR_AUTH_CLIENT_SECRET=<secret>
```

### Topology 3: Executor with Model Restriction

Executors can limit which models they poll for. Useful for heterogeneous hardware.

```yaml
# GPU executor — only model-a (requires GPU)
EXECUTOR_ID=gpu-executor-1
EXECUTOR_MODELS=model-a
EXECUTOR_UPSTREAM_URL=http://gateway:8083

# CPU executor — everything except model-a
EXECUTOR_ID=cpu-executor-1
EXECUTOR_MODELS=model-b,model-c
EXECUTOR_UPSTREAM_URL=http://gateway:8083
```

The master's executor registry tracks `allowedModels` per executor. The GUI only shows executors that are allowed for the selected model.

---

## Failure Modes and Recovery

### Master Goes Down

1. Gateway continues routing requests to the downed master's URL
2. WebClient gets connection refused → gateway returns **502 Bad Gateway** with error JSON
3. After `masterHeartbeatTtlSeconds` (default 60s) without heartbeat, gateway evicts the master
4. Model mappings for the evicted master are removed
5. Subsequent requests for those models fall back to wildcard masters (if any)
6. When the master restarts and re-registers, mappings are restored

### Master Restarts

1. Master calls `POST /internal/masters/register` on startup
2. Gateway stores new master node (overwrites any existing entry with same ID)
3. Explicit model mappings recreated
4. Heartbeat timer resets
5. Normal routing resumes

### Executor Loses Connection to Gateway

1. Poll/discover calls time out (5s/10s respectively)
2. Executor logs debug warning, returns empty response
3. Already-deployed transitions continue running locally
4. When connection restores, next poll cycle resumes normally
5. Master syncs status on next successful poll

### Gateway Restarts

1. All in-memory master registry is lost
2. Seed master re-registered from `gateway.master-url` config
3. Dynamic masters re-register on their next heartbeat cycle (within 15s)
4. During the gap, seed master handles all requests (if configured)
5. Round-robin counters reset — model assignments may shift across wildcard masters

### Split-Brain (Multiple Masters for Same Model)

Not possible by design. Each model maps to exactly one master. If two masters register the same model explicitly, the last registration wins (overwrites the mapping). Wildcard masters never create explicit mappings — they're only used for models without an explicit mapping.

---

## Timing Summary

| Event | Interval | Component |
|-------|----------|-----------|
| Master heartbeat | 15 seconds | Master → Gateway |
| Master eviction check | 10 seconds | Gateway internal |
| Master eviction threshold | 60 seconds since last heartbeat | Gateway internal |
| Executor discovery | 30 seconds | Executor → Gateway |
| Executor poll (per model) | 2 seconds | Executor → Gateway → Master |
| Executor registry TTL | 30 seconds | Master internal |
| Fan-out request timeout | 30 seconds per master | Gateway → Masters |
| Proxy request timeout | 300 seconds | Gateway → Master |

---

## Security Boundaries

```
┌─────────────────────────────────────────────┐
│  External (JWT required)                     │
│                                              │
│  /api/**          → proxy to master          │
│  /node-api/**     → proxy to node            │
│  /vault-api/**    → proxy to vault           │
│                                              │
│  Executor polls via /api/transitions/poll    │
│  with JWT from /oauth2/token                 │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────┴──────────────────────┐
│  Internal (no JWT required)                  │
│                                              │
│  /internal/masters/*  → master registration  │
│  /oauth2/token        → JWT issuance         │
│  /oauth2/jwks         → public key           │
│  /actuator/**         → health/metrics       │
│  /api/health/**       → health checks        │
└─────────────────────────────────────────────┘
```

Masters communicate with the gateway over the `/internal/masters/*` endpoints without JWT. This is intentional — these endpoints are on the backend network and protected by network isolation, not application-level auth.

Executors in gateway mode acquire JWT tokens via `POST /oauth2/token` using client credentials, then include the token in all `/api/**` calls.

The gateway strips the `Authorization` header before forwarding to masters — masters manage their own internal auth (or none, for same-network deployments).
