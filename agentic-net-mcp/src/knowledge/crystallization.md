# Crystallization: when a lane should stop being an agent

AI reasoning is for novel work. Once a lane does the same shaped thing every run, it should
become a deterministic transition — `http`, `map` or `pass` — that costs nothing per fire. This
is the platform's central cost curve, and it is measured, not guessed.

## The signal: an agent that loops instead of finishing

Read `usage_report` or `net_stats` and compare `iterationCount` against the lane's
`maxIterations`. **Equal means the agent was cut off, not that it finished.** Master logs
"reached max iterations (treating as success to keep transition running)" and the usage record
says `success: true`, so a saturated lane and a completed one look identical in the metrics.
`iterationCount == maxIterations` is the tell.

Then look at the per-iteration breakdown:

- **prompt huge, completion tiny** (tens of tokens per turn) — the agent is re-reading a large
  context to emit one small tool call. Cost is dominated by re-sending, not by thinking.
- **prompt climbing steadily** — history accumulating with no convergence.
- **the same subjects repeating** — the agent is not tracking what it already did.

A measured example: a lane whose whole job was six token counts and two writes ran 25/25
iterations, 821k tokens, 75 seconds, and touched only **two** of its six places, alternating
between them. Its own reasoning each turn said "I still need the remaining 5" after reading two.
Swapping the worker model moved this by under 2% — a looping agent is a design problem, not a
model-choice problem.

## Counting is not agent work

Six token counts is the classic false agent. Node answers any number of place counts in one
O(1) call:

```
POST /node-api/models/{modelId}/children/count/batch
{"paths": ["root/workspace/places/p-a", "root/workspace/places/p-b"]}
→ {"modelVersion": 1450082, "counts": {"root/workspace/places/p-a": 0, ...}}
```

One `http` lane replaces the whole agent. The same 821k-token lane became **0 tokens and 5ms**.

**Trap: this endpoint returns `0` for a path that does not exist.** It does not error per path.
A count of zero means "empty place OR no such place" — confirm the place exists before reading
0 as data.

## Shape of the replacement

`http` to fetch, `map` to format, emit to the postsets. Points that cost real debugging time:

- **Fan out to a private copy per consumer.** Two formatter lanes reading ONE token contend on
  its lease, and a `consume:false` reader takes an exclusive lease of its own. Emit the same
  payload to two places instead, and let each consumer consume its own.
- **A `map` produces ONE payload.** `@response` is a single transformed object, so two postsets
  needing different shapes means two map lanes, not one with two emit rules.
- **Response keys containing slashes work.** `${input.data.counts.root/workspace/places/p-a}`
  resolves — the placeholder scanner is depth-based and the path splitter breaks only on dots.
  No intermediate renaming step is needed.
- **There is no `now()` template function.** If the agent version stamped an LLM-generated
  timestamp, that value was fabricated anyway; prefer a real one from the source, such as the
  `modelVersion` the count endpoint returns.

### Do NOT count with `${len(preset)}`

Binding six `take:ALL` presets and taking their length is silently wrong. In the map template
context: **0 tokens leaves the preset absent** entirely, **1 token binds the token object** so
`len()` returns its field count rather than 1, and only 2+ counts correctly. It misreports at
exactly the values a real pipeline sits at.

## Verify before you swap

Build the deterministic lanes alongside the agent, `fire_once` each, and compare the emitted
token against what the agent produced. Then stop the agent and start the replacement — rollback
is stopping the new lanes and starting the old one, provided you left its inscription intact.

The strongest check is not that the token looks right, but that the **real downstream consumer
accepts it**. Fire the chain and confirm the next lane picks the token up and acts.

## Two agent-session cost laws worth knowing

**History grows quadratically.** Every iteration re-sends the whole conversation, so an
N-iteration session costs roughly N × (base + N/2 × per-turn-growth). A 59-iteration rebuild
session was measured at 2.9M tokens carrying ~1.2k of new information per turn. Long agent
sessions are expensive *by construction* — a lane that routinely needs 30+ iterations is a lane
that wants splitting into a pipeline, not a bigger budget.

**Never let one budget both destroy and rebuild.** That measured session spent its budget
deleting the old artifact, was cut off before rebuilding, and the forced last-iteration DONE
recorded `success: true` over an emptied net. If an agent task replaces something, build the new
version alongside and swap — the same rule as swapping a crystallized lane in.
