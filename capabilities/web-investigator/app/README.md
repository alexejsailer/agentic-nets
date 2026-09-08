# Web Investigator: Studio application

A `kind:"application"` package over the web-investigator capability's places. Runtime places are
model-global, so installing it into the model that runs the net binds every store to the **live**
data; the app's own session net is just another canvas over the same places.

| File | What it is |
|---|---|
| `agenticos.app.json` | the source manifest (stores, actions, permissions, surface) |
| `ui/main.mjs` | the dashboard: one vanilla web component, no framework, no imports |
| `web-investigator-1.7.0.application.json` | the packed artifact Studio installs, with `ui/main.mjs` pinned by sha256 (`surface.integrity`) |
| `runtime/session.package.json` | the app's session net (a canvas over the shared places) |
| `check.mjs` | fails when the artifact is missing, its integrity hash no longer matches the UI, or a permission names an unknown action |

Build after any change to the manifest or the UI:

```bash
node ../../../agentic-net-apps/tools/pack-application.mjs --config agenticos.app.json
node check.mjs
```

## What the dashboard does

**First run.** With no usable brief (none, or one still carrying placeholder values) the page shows
a setup card instead of the dashboard. Saving writes the brief; it ships **inactive**, so nothing
classifies or analyses until you press **Resume**. Edit brief on the dashboard opens the same form.

**Understand:** coverage by category (competitor volume by recency against your own inventory),
sources and expansion, cost per day and per lane, fresh competitor articles with own-coverage
verdicts, the latest analysis, crawl health (the health insights, the newest rejections with the
reason, the error count).

**Decide:** `accept-recommendation` (to the article-task queue, with evidence), `dismiss`,
`mark-covered`, `complete-task` (inline note, atomic status flip) and `reopen-task`,
`review-draft`, `set-source-policy`.

**Steer and stop:** `queue-url`, `queue-query`, `add-source` (pending sources are listed until the
next harvest activates them), `request-run` (rollup, own-site index, health, recrawl, harvest,
draft, usage; the net's `t-scout-app-run` lane builds the command and leaves a **receipt** in the
requests store, shown as a strip under the top bar), `pause-investigation` and
`resume-investigation` (flip the brief's `active`; every model lane binds the brief only while it
is active), `create-brief` and `update-brief`.

The app never executes anything itself: every button writes a token, the net does the work.
Idempotency keys are derived from the action input, so two different inputs can never collapse
into one replay. Renders never wipe what you are typing or reading: background refreshes are
deferred while a field has focus or a section is open.

## Install

```bash
# upload the package to the hub (master REST)
curl -X PUT "$MASTER/api/hub/applications/web-investigator/versions/1.7.0" \
  -H 'Content-Type: application/json' \
  --data-binary @web-investigator-1.7.0.application.json

# install into the model running the net
curl -X POST "$MASTER/api/hub/install" -H 'Content-Type: application/json' \
  -d '{"source":"local","name":"web-investigator","version":"1.7.0","targetModelId":"<model>"}'
```

Then open Studio, Applications, Web Investigator and select the model. The decision places
(`p-scout-article-tasks`, `p-scout-decisions`, `p-scout-app-requests`) and the `t-scout-app-run`
lane ship with the capability's net; installing the app alone still works, `request-run` tokens
simply wait until the lane exists.

## Notes

- `instancePolicy: singleton` per model; reinstalling the same version is a no-op collision.
- Agents and MCP clients use the same contract: `application_describe web-investigator` then
  `application_action {name, action, input}`. The derived `writeContract` on each store tells a
  net lane what to stamp when writing directly.
- Blob content (drafts, knowledge packs) is read only through the runtime bridge's `readBlob`,
  which goes via master; the page never contacts a store port.
- The facts token is transient (the analysis lane consumes it), so the matrix reads the persistent
  category tokens and the fresh list falls back to the recency stores.
