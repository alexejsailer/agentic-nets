# LLM transitions: the riskiest kind

llm/agent lanes fail more than any other kind (provider down, model missing, quota, timeout) and
every retry is a BILLED call. Treat this doc as the pre-flight checklist.

## Before building: llm_health

Call the `llm_health` tool (GET, works in readonly). `READY`/`ONLINE` means master can
execute AI lanes. `DISABLED` is the intentional MCP-first mode: deterministic
lanes remain ready and master skips provider-backed llm/agent lanes, leaving them
for a connected client. An agent with `llmMode:"bash"` is the exception: master
uses its local Claude Code/Codex CLI and can run it without a server provider.
`MODEL_NOT_FOUND` or `UNREACHABLE` means provider-backed master-run
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

## provider=disabled: choose the persona's brain explicitly

Desktop Lite ships no server LLM on purpose. Master skips provider-backed llm/agent
lanes rather than failing them, so they keep a normal status (`deployed`, even
`running`) and wait. Serve those through list_external_fires → prepare → complete.
For unattended reasoning without a provider, prefer an `agent` lane with
`llmMode:"bash"` and `binary:"claude"|"codex"`: it preserves the bounded agent/tool
loop and runs on master. A command lane piping a prompt to a headless CLI is the
one-shot alternative on an executor. `host_transition` and external fires cover
reasoning only while their client stays connected; or enable a provider in Studio →
Settings → Desktop LLM (also reachable from the tray).

`external` is never implied by a missing provider — it means someone called
`set_external`, nothing else. Do NOT look for that status alone to find your work.
Use `list_external_fires {includeAll:true}` and its `requiresServerLlmProvider`,
`executionBackend`, and `servableReason` fields. CLI-backed agents remain master-owned;
provider-backed lanes with no provider are the stranded ones.

Two things to say out loud rather than let the user discover:

1. **Provider-backed lanes cannot be scheduled unattended without a provider.** Their
   cron is armed but dispatched by nobody (docs/scheduling). CLI-backed agents and
   deterministic lanes are unaffected.
2. **Check the backlog when you connect.** `readiness.externalFires.waiting` counts
   lanes holding bound tokens; `.stranded` counts lanes master cannot run at all.
   Report both and offer to work them (`work-external-fires` is the recipe). That offer
   is the only thing between the user and a queue that never drains.
