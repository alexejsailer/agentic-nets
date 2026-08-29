# Place Inspector

NL-delegated, read-only place observability with measured answers. The second pack in this
directory, and the first one **authored as files first**: nobody built this interactively.
Capabilities as code, literally.

**Source of truth**: `nets/persona-inspector.net.json` (compact source, ~230 lines) +
`charters/inspector-parse.md` (the agent's prompt as editable markdown). `pack.mjs build`
compiles them into the full `.pnml.json` + `.inscriptions.json` pair - arcs, layout, and all
inscription boilerplate are derived. The compiled output was proven deep-equal to the
hand-written, live-verified originals, then reinstalled from the build and smoked 4/4 again.

## What it does

```
delegate {capability: "place-inspector",
          request: "how many tokens are in p-fj-shipped in academy"}
```

- **The agent decides** (tier medium, decision-only): reads the NL request, picks `count`,
  `sample`, or `unknown`. It never produces a number.
- **The pipeline measures**: deterministic http lanes call the master API; `count`, `sample1..3`
  and the message are composed by map transitions from the API response.
- **The gate refuses first**: reading is disclosure, so the same allowlist/denylist gate as the
  janitor guards it. Out-of-scope model or protected place is refused before anything is read.
- **Unknown is honest**: a delete/write request routes to `unsupported`, never to a guess.

What it adds over token-janitor as an example: **two live strategies** behind one dispatch
(the janitor routes only `clear-place`), proving the multi-strategy `route` pattern:
`match(strategy, "^(count|sample)$")` with a literal default, and one emit pair per route value.

## Contract

| | |
|---|---|
| Inbox | `p-inspector-task` - flat fields `{requestId, request}` + optional `{targetModel, place}` |
| Outbox | `p-inspector-output` - correlated on `requestId` |
| Statuses | `done`, `refused`, `unsupported`, `failed` |
| Result | `status, strategy, count, sample1..sample3, message` |

## E2E

```
node capabilities/tools/pack.mjs build   --dir capabilities/place-inspector          # compact source -> compiled pair (offline)
node capabilities/tools/pack.mjs install --dir capabilities/place-inspector --model default --session agent-place-inspector
node capabilities/tools/pack.mjs verify  --dir capabilities/place-inspector --model default
node capabilities/tools/pack.mjs uninstall --dir capabilities/place-inspector --model default --session agent-place-inspector
```

`install --model <id>` injects the whole net + inscriptions + seeds + manifest into any model on
the connection's allowlist - hosts and the agent's modelId are normalized to the target, so the
same compiled files work on staging, compose, or Desktop.

Smoke notes: `count`/`sample` cases assert presence (`"*"`) rather than absolute numbers because
the shared demo places accumulate seeds across runs - and cleaning them is deliberately not this
pack's job (it is read-only). When residue bothers you, delegate the cleanup:
`delegate {capability: "token-janitor", request: "clear p-smoke-count in academy"}` - packs
composing packs.
