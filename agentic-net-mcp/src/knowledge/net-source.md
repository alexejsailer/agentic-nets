# Compact net source: design upfront, install in one call

When the design of a net is known upfront, do NOT hand-wire it tool by tool. Author the whole
net as one compact source object and hand it to `install_net` — compile + create + inscribe +
seed + start in a single call. Then verify with the normal tooling (below). This is the
preferred order: **design → install_net → verify**.

## The source object

```json
{
  "net": "persona-greeter",
  "session": "agent-greeter",
  "places": { "p-greet-task": "Task inbox", "p-greet-out": "Replies" },
  "transitions": [
    {
      "id": "t-greet-parse", "kind": "agent",
      "label": "Greeter: decide the reply style",
      "reads":  { "task": "p-greet-task",
                  "policy": { "place": "p-greet-policy", "consume": false } },
      "writes": { "intent": "p-greet-intent" },
      "agent":  { "tier": "medium", "maxIterations": 6,
                  "charter": "greeter" }
    },
    {
      "id": "t-greet-fetch", "kind": "http",
      "label": "Fetch profile",
      "reads":  { "go": "p-greet-intent" },
      "writes": { "raw": "p-greet-raw", "err": "p-greet-fail" },
      "http":   { "url": "${master}/api/runtime/places/${urlencode(go.data.place)}/tokens?modelId=${urlencode(go.data.m)}" }
    },
    {
      "id": "t-greet-compose", "kind": "map",
      "label": "Compose from measured values",
      "reads":  { "raw": "p-greet-raw", "ctx": "p-greet-ctx" },
      "writes": { "answer": "p-greet-out" },
      "template": { "requestId": "${ctx.data.requestId}", "msg": "..." }
    }
  ]
}
```

Everything mechanical is derived: arcs (one per read/write), a deterministic layout,
preset/postset boilerplate (`FROM $ LIMIT 1`, `take FIRST`, `consume true`, hosts for THIS
deployment), default emits, mode, metadata. Prompts travel in the `charters` parameter
(name -> markdown string) or inline as `agent.nl`.

## Field cheatsheet

- `reads`/`writes`: alias -> place id, or `{place, consume:false, arcql, take, ttl}` /
  `{place, capacity}`. The alias is what templates reference (`${input.data.x}`).
- `kind: map` needs `template`; omitted `emit` means one unconditional emit per write alias.
  Multi-route: compute a literal field (e.g. `"route": "${default(match(...), \"OTHER\")}"`)
  and give one emit pair per literal — `when` compares to LITERALS only, no `&&`, no else.
- `kind: http` needs `http.url` (`${master}` is substituted). With `raw` + `err` writes the
  success/error emit pair is derived. Always give http/llm lanes an `err` write.
- `kind: agent` is a DECISION step: small charter, low maxIterations, writes ONE intent token;
  deterministic lanes measure and compose results (the agent never authors counts).

## install_net extras

- `seeds`: placeId -> config tokens (policy, routing knowledge). Never re-seeded when the
  place already holds tokens.
- `manifest` + `tags: ["agents","capability-pack"]`: makes the session a discoverable
  capability pack (`find_capabilities` / `delegate`).
- `suffix`: place ids are model-global — a second copy needs one.
- `model`: install the same source into any allowlisted model; hosts and the agent's modelId
  are normalized to the target.

## Verify — not optional

An install that was never smoked is a design, not a capability. After `install_net`:
1. `verify_inscription` on each lane (or spot-check the riskiest).
2. Inject ONE real token into the entry place; `query_tokens` the outbox; `event_trail` a
   transition if it stalls. `fire_once` suits deterministic lanes.
3. `net_stats` for errors + executor coverage; `diagnose_transition` on anything stuck.
4. For packs: exercise every declared status (happy, refusal, unsupported, failure) with
   injected tokens before calling it done.

`uninstall_net` reverses an install (transitions + net; runtime places, tokens and the
manifest leaf survive so a re-install is an upgrade, not a reset).
