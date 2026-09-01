# Web Investigator — Studio application

A `kind:"application"` package over the web-investigator capability's places. Because runtime
places are model-global, installing it into the model that runs the net binds every store to the
**live** data — the app's own session net is just another canvas over the same places.

Two variants share the identical store/action contract:

| File | Surface |
|---|---|
| `web-investigator.application.json` | **1.0.0, generic** — Studio's declarative renderer, zero custom JS |
| `web-investigator-1.1.1.application.json` | **1.1.1, custom dashboard** — coverage matrix, fresh articles with own-coverage verdicts and Accept/Covered/Dismiss, analysis reader with accept-as-task on each recommendation, task queue, crawl controls |

The dashboard is a single vanilla web component (`ui/main.mjs`, no framework, no imports —
required by the trusted-element packer), built with `agenticos.app.json` +
`agentic-net-apps/tools/pack-application.mjs`, sha256-pinned and re-verified by the browser
before mount. It reads only through the injected `runtime` bridge. Design constraint learned
live: the facts token is TRANSIENT (the analysis lane consumes it), so the matrix reads the
persistent category tokens and the fresh list falls back to the recency stores.

**Understand:** findings by recency, landscape analyses, the category rollup, crawl-health
insights, the owner's own inventory. **Decide:** `accept-recommendation` (→ the article-task
queue, with evidence), `dismiss`, `mark-covered`, `complete-task` (atomic status flip),
`queue-url` / `queue-query` (steer the crawl), `request-run` (the net's `t-scout-app-run` lane
consumes the request and builds the actual command — the app never executes anything itself).

## Install

```bash
# upload the package to the hub (master REST; the generic surface needs no packer)
curl -X PUT "$MASTER/api/hub/applications/web-investigator/versions/1.0.0" \
  -H 'Content-Type: application/json' \
  --data-binary @web-investigator.application.json

# install into the model running the net
curl -X POST "$MASTER/api/hub/install" -H 'Content-Type: application/json' \
  -d '{"source":"local","name":"web-investigator","version":"1.0.0","targetModelId":"<model>"}'
```

Then open Studio → Applications → Web Investigator and select the model. The three decision
places (`p-scout-article-tasks`, `p-scout-decisions`, `p-scout-app-requests`) and the
`t-scout-app-run` lane ship with the capability's net; installing the app alone still works —
`request-run` tokens simply wait until the lane exists.

## Notes

- `instancePolicy: singleton` per model; reinstalling the same version is a no-op collision.
- Agents/MCP use the same contract: `application_describe web-investigator` →
  `application_action {name, action, input}`. The derived `writeContract` on each store tells a
  net lane what to stamp when writing directly.
- Phase B (optional): a custom web-component dashboard can replace `surface` without changing
  the stores/actions — see `docs/applications/DEVELOPER_GUIDE.md` and the approval-room example.
