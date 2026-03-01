# Agentic-Net Executor: Command Execution Guide

This document describes the **command-only** agentic-net-executor runtime and its interaction with agentic-net-master.

## 1. Deployment Interface (Master-Driven)

The executor does **not** expose transition CRUD or fire endpoints. Transitions are assigned and
managed via agentic-net-master:

- `POST /api/transitions/assign` (master) stores inscription + assignment
- Executor polls `GET /api/transitions/poll?modelId=...&executorId=...`
- Master responds with lifecycle commands: `DEPLOY`, `START`, `STOP`, `DELETE`, `FIRE`, etc.

Health/metrics endpoints exposed by the executor:
- `GET /api/health`
- `GET /api/health/detailed`
- `/actuator/prometheus`

## 2. Data Model Essentials

`TransitionDefinition` wraps:
- `transitionId`
- `TransitionInscription` (command action only)
- `TransitionMetrics` (success/failure counters)
- `TransitionStatus`, `lastError`, tags, timestamps

`TransitionStore` is in-memory and scoped to the executor process.

## 3. Execution Agentic (Command Only)

1. **Assignment**: master stores inscription + executor assignment.
2. **Polling**: executor polls master every ~2s.
3. **Deploy**: master sends `DEPLOY` when executor needs the transition.
4. **Fire**: master binds preset tokens (ArcQL) and sends `FIRE` with pre-bound tokens.
5. **Execute**: executor runs command tokens locally.
6. **Emit/Consume**: executor calls master APIs to emit outputs and consume inputs.

## 4. Command Action Schema

Executor only accepts transitions where:

```
"action": { "type": "command", ... }
```

`kind` is ignored for routing; `action.type` is the source of truth.

## 5. Manual FireOnce

`POST /api/transitions/{id}/fireOnce` (master) binds tokens and **queues** a one-shot `FIRE`
command for the assigned executor. The executor executes it on the next poll cycle.
