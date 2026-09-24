# spec-001: Add daily digest lane to steward-observe

kind: add-lane

Add a scheduled map lane inside steward-observe that reads the newest health token every morning at 06:00 Europe/Berlin and writes a retained digest token. This gives the person a compact daily summary without changing existing observe lanes or any protected place. The new digest place is also exposed as a read store in the app manifest.

## Why
Answers the person's request in pr-it-20260909T143211Z-2 for a daily digest lane, and supports the readability goal from it-20260909T143211Z by turning per-observation health tokens into a retained summary.

### Nets touched
- steward-observe

### Lanes and places touched
- t-steward-observe-digest
- p-steward-digest

### A new lane reads
- p-steward-health

### A new lane writes
- p-steward-digest

### Changes, in order
- In nets/steward-observe.net.json, add place p-steward-digest with retain 30 to the places list.
- In nets/steward-observe.net.json, add map lane t-steward-observe-digest scheduled cron 0 0 6 * * * timezone Europe/Berlin, reading p-steward-health with consume false and writing p-steward-digest.
- In app/agenticos.app.json, add p-steward-digest as a read store in the Steward app stores section.
- Run `node capabilities/tools/pack.mjs build --dir capabilities/steward` and verify the smoke test passes.

### Files expected to change
- nets/steward-observe.net.json
- app/agenticos.app.json

### Verify after install
After install, `node capabilities/tools/pack.mjs build --dir capabilities/steward` succeeds and a manual or scheduled fire of t-steward-observe-digest writes a token to p-steward-digest, which retains up to 30 tokens.

### Rollback
previous pack version

### Blast radius
Only steward-observe gains one map lane and one new place; no protected lanes or places are modified or stopped.
