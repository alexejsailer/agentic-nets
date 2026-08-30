# Inscriptions: per-kind reference

An inscription is a transition's runtime config: `{id, kind, presets, postsets, action, emit,
mode, schedule?}`. The curated `add_transition` writes known-good inscriptions for you — reach for
raw `SET_INSCRIPTION` only when you need a shape it can't express. Every kind below is a complete,
valid template. `mode` is `SINGLE` (one fire per binding) — the default you want.

## pass — route a token unchanged

```json
{"id":"t-route","kind":"pass",
 "presets":{"input":{"placeId":"p-a","host":"{model}@localhost:8080","arcql":"FROM $ LIMIT 1","take":"FIRST","consume":true}},
 "postsets":{"out":{"placeId":"p-b","host":"{model}@localhost:8080"}},
 "action":{"type":"pass"},
 "emit":[{"to":"out","from":"@input.data"}],"mode":"SINGLE"}
```

## map — deterministic template transform (action allows ONLY type, template)

```json
"action":{"type":"map","template":{"summary":"${input.data.title}","total":"${sum(input.data.items, \"qty\")}"}}
```
Emit `from: "@response"`. The template supports functions — see docs/interpolation.

## http — API call (action allows type, method, url, headers, body, timeoutMs, retry, auth, on, idempotency)

```json
"action":{"type":"http","method":"POST","url":"https://api.example.com/items?q=${urlencode(input.data.q)}",
 "headers":{"Authorization":"Bearer ${credentials.API_TOKEN}","Content-Type":"application/json"},
 "body":"{\"name\":\"${input.data.name}\"}","timeoutMs":30000}
```
Emit `from: "@response.json"` (parsed body) or `@response` (status+body). `auth` block alternative:
`{"type":"bearer","credentialKey":"API_TOKEN"}`. `on.success.codes` customizes which statuses count
as success. Fields like `query`/`params`/`extract` are silently ignored — build the query string
into `url`. Via `add_transition` all of this is available directly (headers/body/auth/retry/emit/
errorPlace) — always wrap user input in `${urlencode(...)}`.

## llm — one AI inference (action allows type, nl|prompt, system, model, group, tier, timeoutMs)

```json
"action":{"type":"llm","prompt":"Classify: ${input.data.text}. Return JSON {\"category\":...}",
 "tier":"low","timeoutMs":240000}
```
Emit `@response.json` (parsed) or `@response.raw` (raw text). Set `timeoutMs` explicitly (bare
default is 60s — real prompts blow it). Read docs/llm for the failure modes BEFORE building.

## command — shell on an executor (action allows type, inputPlace, executorId, dispatch, await, timeoutMs, groupBy)

```json
"action":{"type":"command","inputPlace":"input","dispatch":[{"executor":"bash","channel":"default"}],
 "await":"ALL","timeoutMs":300000}
```
Emit `from: "@result"`. NO `${...}` and no `command`/`cwd` fields in the action — the command comes
from the consumed TOKEN (full CommandToken schema, docs/commands); dynamic commands are built by an
upstream map. Executor choice via `action.executorId` ('*' = any).

## agent — autonomous multi-step persona

```json
"action":{"type":"agent","nl":"Work the task: ${input.data}","modelId":"{model}","role":"rwxhl---t",
 "maxIterations":12,"autoEmit":true,"timeoutMs":240000}
```
**`role` must be inside `action`** — a root-level role is ignored by the engine and the agent
silently runs as `rw--` (no execute/http/tool-nets). INVOKE_TOOL_NET is gated by the `t` flag, so a
worker that should call tool-nets needs `rwxhl---t` (plain `rwxhl` cannot invoke them). Optionally
add `"capabilityProfile"` to narrow the exact tool set below the role ceiling (profiles can only
narrow — a profile tool the role does not grant fails template validation). Two-tier config:
`toolsModel`/`thinkingModel`/`activeTier` pick the LLM per fire. `autoEmit: true` routes the final
result to the single postset.

External MCP servers: `"mcp":[{"name":"hub","url":"http://localhost:8091/mcp",
"auth":{"credentialKey":"MCP_TOKEN"},"allowTools":["readiness"]}]` + the `m` role flag
(`rwxh------m`) gives the agent those servers' tools via MCP_CALL. Auth ONLY via credentialKey
(set_transition_credentials); an unreachable server degrades, it never fails the fire.

## link — pure structure edge, never fires

Presets/postsets only (`consume:false, optional:true` preset), no action, never started.

## Universal rules

1. Preset `arcql` is NEVER empty (`FROM $ LIMIT 1` minimum — even for link).
2. Preset KEY = the `${...}` prefix (`"input"` preset ⇒ `${input.data.x}`) — docs/interpolation.
3. Always at least one emit; end with a catch-all — docs/emit.
4. Secrets ONLY via `${credentials.KEY}` + set_transition_credentials — never inline (docs/security).
5. After changing an inscription, the transition is STOPPED (assign stops it) — start it again.
