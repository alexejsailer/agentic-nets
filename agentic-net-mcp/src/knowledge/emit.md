# Emit rules & token-loss prevention

Emit rules route a fire's result to postsets: `{"to": "<postsetKey>", "from": "<source>",
"when": "<condition>"}`.

## from — where the data comes from (per kind)

- `@response` — map result (also: llm full response object).
- `@response.json` — http/llm parsed JSON body.
- `@response.raw` — llm raw text (the robust choice — docs/llm).
- `@result` — command execution result (`batchResults[].results[].output.stdout`).
- `@input.data` — pass the input token through.
- Any other `@path` resolves against the response context; a plain string is template-interpolated.

## when — evaluated against the EMITTED data, not the input

`when` defaults to `"success"`. `"error"` routes failures. Anything else is a condition evaluated
on what `from` resolved to — `"when": "category == 'urgent'"` checks the emitted object's field
(flat paths). A custom condition that references input-token fields does not work; route on the
result, or put the decision into the result.

## Success/error split

```json
"emit":[
  {"to":"out","from":"@response.json","when":"success"},
  {"to":"err","from":"@response","when":"error"}
]
```
http has always supported this; **llm supports it from master 2.28** (before that an llm failure
emitted NOTHING — the lane silently stalled; docs/llm). The curated `add_transition` builds the
split for you when you pass `errorPlace`. Give every lane that can fail a visible error place —
"failures land somewhere I can query" is the cheapest observability you can buy.

## Token-loss prevention (the catch-all rule)

If NO emit rule matches a fire's outcome, the result is dropped AND the input tokens stay
unconsumed — by design (data is never silently destroyed), but the lane then re-fires the same
token forever. End every emit list with a catch-all (an unconditional rule, or a success+error
pair) so every outcome has a destination.

## Capacity backpressure

A postset can declare `"capacity": N`. When the target place holds ≥ N tokens the transition stops
firing — that is backpressure, not an error. Symptom: healthy-looking lane, input tokens piling
up, downstream place exactly at its cap. Drain the place or raise the capacity.

## Correlation passthrough

Tool-net invocations correlate request↔result via `_correlationId`. The engine auto-injects it on
http/llm emissions, so concurrent invoke_tool_net calls of the same tool-net don't cross-talk. If
you hand-build a map that REPLACES the token, carry `"_correlationId": "${input.data._correlationId}"`
through the template.
