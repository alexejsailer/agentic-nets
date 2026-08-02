# LLM transitions: the riskiest kind

llm/agent lanes fail more than any other kind (provider down, model missing, quota, timeout) and
every retry is a BILLED call. Treat this doc as the pre-flight checklist.

## Before building: llm_health

Call the `llm_health` tool (GET, works in readonly). `READY` means master can
execute AI lanes. `DISABLED` is the intentional MCP-first mode: deterministic
lanes remain ready and new llm/agent lanes default to external execution by the
connected client. `MODEL_NOT_FOUND` or `UNREACHABLE` means master-run
llm/agent fires fail until fixed (a cloud model that is not authenticated on the
provider host is the classic case).

## kind:llm — the gotchas

- **tier** (`"low" | "medium" | "high"`): resolved to a per-tier model on masters ≥ 2.28. On OLDER
  masters `tier` on kind:llm is a SILENT NO-OP and the fire runs on the provider base model — the
  expensive one. Explicit `action.model` always wins over tier.
- **Failures & the error branch**: on masters ≥ 2.28 a failed llm fire routes `when:"error"` emit
  rules (like http always did) — give every llm lane an error place. On OLDER masters a failed llm
  fire emits NOTHING: the input stays unconsumed, the lane retries on backoff (each retry billed),
  and the net just looks stalled. Watch `net_stats.recentErrors`.
- **timeoutMs**: set it explicitly (the engine default is 60s; grounded prompts blow it; the
  curated builder uses 240000).

## @response.json parse fallback — a different shape that still says success

The engine strips markdown fences and parses the LLM output. When parsing FAILS you get
`{"text": <raw>, "parseError": "..."}` instead of your expected object. On masters ≥ 2.28 this is
surfaced (`parseError` in fire metadata; routed to the error branch when the inscription consumes
`@response.json` AND has one). On older masters the fire reports plain SUCCESS and a downstream
`${input.data.sentiment}` silently resolves empty.

**The working pattern**: emit `@response.json` (the add_transition default) with an `errorPlace`,
and instruct the model to "return ONLY JSON, no fences" — parsed fields land as top-level data
properties a downstream `${input.data.field}` interpolates. `@response.raw` is for FREEFORM text
only: it stores the reply as a JSON-escaped string under `value`, so a JSON reply arrives
double-encoded and its fields can never interpolate downstream (proven live).

## kind:agent — two-tier config

Agent transitions pick their LLM per fire: `toolsModel` (the cheap worker), `thinkingModel` (the
reasoner), `activeTier` (`"tools" | "thinking"` — which one is live). Flip `activeTier` via a
SET_INSCRIPTION patch; it takes effect on the NEXT fire, never mid-turn. `llmMode` selects api vs
bash execution. And remember: the agent's `role` lives in `action.role` (docs/inscriptions) — a
root-level role silently downgrades to rw--.

## Cost discipline

An llm lane on a schedule burns tokens forever — always tell the user what you armed, check
`net_stats.llm.byTransition` for per-lane consumption, and prefer map/http for anything
deterministic (docs/concepts: deterministic first).

## provider=disabled means YOU are the model

Desktop Lite ships no server LLM on purpose. Master then SKIPS every llm/agent lane
rather than failing it, so lanes keep a normal status (`deployed`, even `running`)
and simply wait — serving them is YOUR job: list_external_fires → prepare → complete.
A lane that "never fires" here is usually one nobody served. For unattended AI
lanes: host_transition, or the user enables a provider in Studio → Settings →
Desktop LLM (also reachable from the tray).

`external` is never implied by a missing provider — it means someone called
`set_external`, nothing else. So do NOT look for `external` to find your work: with
no provider EVERY llm/agent lane is yours, whatever its status. Use
`list_external_fires {includeAll:true}`; the default view omits exactly the stranded ones.

Two things to say out loud rather than let the user discover:

1. **They cannot be scheduled unattended.** Master skips them, so a cron is armed but
   dispatched by nobody (docs/scheduling). Deterministic lanes are unaffected.
2. **Check the backlog when you connect.** `readiness.externalFires.waiting` counts
   lanes holding bound tokens; `.stranded` counts lanes master cannot run at all.
   Report both and offer to work them (`work-external-fires` is the recipe). That offer
   is the only thing between the user and a queue that never drains.
