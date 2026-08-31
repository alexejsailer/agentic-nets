# Two layers: PNML vs runtime

The #1 mistake of every new client: treating the drawing as the machine. Agentic-Nets has TWO
separate layers, and knowing which one you are touching explains most "it doesn't work" moments.

## Layer 1 — design-time PNML (the drawing)

Lives at `sessions/{sessionId}/workspace-nets/{netId}/pnml/net` (places / transitions / arcs with
coordinates and labels). This is what the GUI renders. It does NOT execute. Its `tokens` field is
the INITIAL marking — a design-time number that never updates as the net runs (a place showing
`tokens: 0` in the PNML/export says nothing about live traffic; read runtime tokens with
query_tokens).

## Layer 2 — runtime (the machine)

- Tokens flow through RUNTIME places: `root/workspace/places/{placeId}`.
- Transitions execute from RUNTIME state: `root/workspace/transitions/{transitionId}` holds the
  `inscription` leaf (the config), `status`, `assignedAgent`, `deployedAt`, and metrics.

**The critical rule: inscriptions reference RUNTIME places, never PNML places.** A preset's
`placeId` resolves under `root/workspace/places/` only. The curated `add_place` creates BOTH
layers; if you build via native tools, `CREATE_PLACE` (PNML) must be paired with
`CREATE_RUNTIME_PLACE`, or the transition fails with "Place not found".

## Host format

Every preset/postset carries a host: `{modelId}@{host}:{port}` — e.g. `my-model@localhost:8080`
locally or `my-model@agentic-net-node:8080` in compose. Missing the `modelId@` prefix is a classic
silent failure. `root` in paths is an alias for the model's root sentinel, not a literal node name.

## Transition lifecycle

`undeployed → deployed → starting → running → stopped` (plus `error`). The master only sends FIRE
when the transition has BOTH a status of running AND a `deployedAt` timestamp. A transition can
read "running" in a status view yet still be waiting — check `ready` (token binding) and
`eligibility` (why-not-firing) via scheduler_status / list_transitions. `fire_once` works on a
STOPPED transition (that is the fire-on-demand pattern) but returns 409 while it is RUNNING —
stop, fire, start.

## New-model provisioning

A brand-new model contains only `root`. Since 2.27.0 the workspace skeleton
(`root/workspace/places`, …) is auto-provisioned on first use (`add_place` just works); on older
stacks the first `add_place` 404s until something creates the containers.

## Sessions scope the drawings, not the runtime

Design-time nets live per session; runtime places/transitions are model-global. That is why a
fresh MCP connection's `net_overview` can show `sessionNetCount: 0` while the model is full of
running nets — check `modelSessionCount`/`sessionIds`, then inspect other sessions explicitly.

## View nets: structure a big net as several small ones

Because runtime is model-global, several designtime nets can draw the SAME place and transition
IDs — one big runtime, many small readable canvases. Keep one canonical net (transitions'
`metadata.netId` point at it) and add per-stage views drawing shared elements. Tooling
classifies instead of crying drift: `sync_net`/`net_overview` report `netRole` + `viewOf`; a
shape is stale only when NO runtime backs it anywhere. `DELETE_PLACE` removes one canvas shape
only — the runtime place and tokens survive, and the response warns via `stillDrawnIn`/`boundBy`.
Convention: name views `<net>-<stage>`, description "Designtime view of '<net>'".
