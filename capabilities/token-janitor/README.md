# Token Janitor

NL-delegated token deletion with measured results. The reference implementation of the
[capability pack contract](../CONTRACT.md); live on staging as session `agent-token-janitor`
in model `default` since 2026-08-26.

## What it does

You write one task token (or just `delegate`):

```
delegate {capability: "token-janitor",
          request: "clear the stale tokens out of p-inbox in net-lab"}
```

Behind the inbox, the split that makes the pack trustworthy:

- **The agent decides** (worker tier, decision-only): reads the NL request, picks a strategy
  (`preview` / `clear` / refuse-as-unsupported). It never produces a number.
- **The pipeline measures**: deterministic lanes count the place BEFORE, execute via the member
  tool nets, count AFTER, and compose the reply. `before`, `deleted`, `after` are measured facts
  the model cannot author.
- **The gate refuses first**: a target model outside `allowedModels`, or a place listed in
  `protectedPlaces`, is refused by a deterministic gate before anything is even read.

## Contract

| | |
|---|---|
| Inbox | `p-janitor-task` - flat fields `{requestId, request}` + optional `{targetModel, place}` |
| Outbox | `p-janitor-output` - correlated on `requestId` |
| Statuses | `done`, `refused`, `nothing-to-do`, `unsupported`, `failed` |
| Result | `status, strategy, before, deleted, after, message` |

## Member nets

| Net | Role | Purpose |
|-----|------|---------|
| `persona-janitor` | front-door | Entry, policy gate, deciding agent, measure/compose lanes |
| `tool-preview-place` | tool | Count and sample a place without touching it |
| `tool-clear-place` | tool | Bulk-delete every token in one place, before/after counted |

## Status of this directory

Fully round-trip proven on staging (2026-08-29): exported from the live pack with
`tools/pack.mjs export`, re-installed as a suffixed copy (`token-janitor-e2e`) with
`tools/pack.mjs install`, discovered via `find_capabilities`, and `verify/smoke.json`
passed **4/4 on both the installed copy and the live pack**.

```
node capabilities/tools/pack.mjs export  --dir capabilities/token-janitor --model default --session agent-token-janitor
node capabilities/tools/pack.mjs install --dir capabilities/token-janitor --model default \
     --session agent-token-janitor-e2e --suffix -e2e --name token-janitor-e2e
node capabilities/tools/pack.mjs verify  --dir capabilities/token-janitor --model default [--suffix -e2e]
```

Suite semantics worth knowing: on an empty place the pipeline's `nothing-to-do` short-circuit
wins over `unsupported`, so the preview case seeds its own tokens; and the clear case asserts
the invariant (`after == 0`) rather than absolute counts, because the shared demo place may
carry residue from a previous run.
