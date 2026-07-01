# The seven transition kinds + inscription templates

An **inscription** defines how a transition executes: `presets` (input places + ArcQL binding), `action` (the
work), `emit` (routing of results to `postsets`), and `mode` (SINGLE / FOREACH). Set inscriptions with
**`POST /api/transitions/assign`** — never `POST /api/runtime/transitions` (it nulls the value).

| Kind | `kind` | Runs on | `emit.from` | Purpose |
|------|--------|---------|-------------|---------|
| Pass | `task` | master | `@input.data` | routing / conditional |
| Map | `map` | master | `@response` | template transform |
| HTTP | `http` | master | `@response.json` | external API call |
| LLM | `llm` | master | `@response.json` | single inference |
| Agent | `agent` | master | `@response` | autonomous multi-step AI + tools |
| Command | `command` | executor | `@result` | shell/script on an executor |
| Link | `link` | master | n/a | structural edge (knowledge graph); moves no tokens |

## Assign contract

```bash
anos.sh master POST /api/transitions/assign '{
  "modelId":"<model>", "transitionId":"t-x", "agentId":"agentic-net-executor-default",
  "inscription": { ...see templates... }, "credentials": {}
}'
```
(`agentId` matters mostly for `command` transitions; master-run kinds ignore the executor binding.)

## Templates (minimal)

**Map** (reshape input -> output):
```json
{"id":"t-x","kind":"map",
 "presets":{"input":{"placeId":"p-in","arcql":"FROM $ LIMIT 1","take":"FIRST","consume":true}},
 "postsets":{"out":{"placeId":"p-out"}},
 "action":{"type":"map","template":{"greeting":"hi ${input.data.name}"}},
 "emit":[{"to":"out","from":"@response"}],"mode":"SINGLE"}
```

**HTTP**:
```json
{"id":"t-x","kind":"http",
 "presets":{"input":{"placeId":"p-in","arcql":"FROM $ LIMIT 1","take":"FIRST","consume":true}},
 "postsets":{"out":{"placeId":"p-out"}},
 "action":{"type":"http","method":"GET","url":"https://api.example.com/${input.data.id}"},
 "emit":[{"to":"out","from":"@response.json"}],"mode":"SINGLE"}
```

**Command** (executor):
```json
{"id":"t-x","kind":"command",
 "presets":{"input":{"placeId":"p-in","arcql":"FROM $ LIMIT 1","take":"FIRST","consume":true}},
 "postsets":{"out":{"placeId":"p-out"}},
 "action":{"type":"command","inputPlace":"input","groupBy":"executor",
           "dispatch":[{"executor":"bash","channel":"default"}],"await":"ALL","timeoutMs":300000},
 "emit":[{"to":"out","from":"@result","when":"success"}],"mode":"SINGLE"}
```
The input token itself carries the command: `{"kind":"command","executor":"bash","command":"exec",
"args":{"command":"...","timeoutMs":60000,"captureStderr":true}}`. When running a CLI tool, redirect stdin:
`your-cli ... < /dev/null` (else it hangs).

**Agent** (autonomous): action `{"type":"agent","nl":"@input.data.instruction","role":"rwxhl","autoEmit":false,
"reservationTtlMs":600000}`. Keep `autoEmit:false` and a long TTL, or it double-fires.

## Rules that bite

- **Emit `when`** evaluates against what `from` resolves to (flat), not the input. Always add a catch-all emit
  (no `when`) or unmatched tokens are NOT consumed (they pile up).
- **Capacity gate** default 50 (set `"capacity":N` on a postset). At capacity, the transition silently stops.
- **`consume:true`** removes the input token on fire; `optional:true` lets a transition fire with no match.
- **Templates** use hierarchical access: `${input.data.field}`, `${input._meta.id}` (no flattening).
