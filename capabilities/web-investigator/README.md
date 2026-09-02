# Web Investigator

**A research assistant that watches the web on a topic you choose, compares what it finds
against your own website, tells you what's worth writing next — and drafts it.**

You give it a brief ("investigate X") and a few starting URLs. From then on it reads competitor
pages, files them by age and category, checks each one against your own published articles, and
produces an analysis with concrete recommendations. You accept the ones you like with a click;
a staff writer drafts them; you publish and mark them done. Everything runs on an ordinary
Agentic-Net — the dashboard is just a window onto it.

## The idea in one picture

```
 you: brief + seed URLs                    your site: sitemap (indexed, NEVER crawled)
        │                                                     │
        ▼                                                     ▼
   ┌─ CRAWL ────────────┐   ┌─ ANALYSE ───────────────────────────────┐
   │ fetch pages        │   │ count by category × age                 │
   │ find their links   │──▶│ subtract what YOU already cover         │
   │ score relevance    │   │ → "true gaps" + a written analysis      │
   │ classify + file    │   └───────────────┬─────────────────────────┘
   └────────────────────┘                   ▼
                              ┌─ DECIDE (the dashboard) ──────────────┐
                              │ Accept → task   Dismiss   Covered     │
                              └───────────────┬───────────────────────┘
                                              ▼
                              ┌─ WRITE ───────────────────────────────┐
                              │ staff writer drafts the accepted task │
                              │ you copy → publish → mark Done        │
                              └───────────────────────────────────────┘
```

Two rules make the output trustworthy:

1. **Every number is measured, never model-written.** Scripts do all counting, dating, scoring
   and dedupe; models only classify and interpret. An AI asked to both count and interpret
   fabricates the counts.
2. **Your own site never enters the crawl.** Only its sitemap is indexed (URLs + dates, no page
   content), so "uncovered" genuinely means *you have no equivalent* — the analysis will not
   recommend topics you already rank for.

## Getting started

### 1. Install the net

```bash
export AGENTICOS_MCP_URL=http://127.0.0.1:8091/mcp
export AGENTICOS_MCP_TOKEN=<your mcp token>

node capabilities/tools/pack.mjs install \
  --dir capabilities/web-investigator \
  --model my-research \
  --session agent-web-investigator
```

Install deliberately does **not** go live: the brief ships as a REPLACE-ME template, and
starting lanes against placeholder config helps nobody.

### 2. Fill in the brief

Edit the token in `p-scout-brief` (Studio → Token Workbench, or MCP). The whole net retargets
from this one token — no lane changes needed:

| Field | What it means |
|---|---|
| `topic`, `description` | what you are investigating, in your words — handed to the analyst verbatim |
| `domainHint` | vocabulary that helps the classifier (product names, brands, jargon) |
| `categories` | the closed list every finding is sorted into |
| `mustInclude` / `mustExclude` | words that raise / kill a page's relevance score |
| `minScore` | how much reaches a model — the main cost lever |
| `denyHosts` | sites never to crawl — **put your own site here** |
| `ownSitemap` | your sitemap URL — how the net learns what you already cover |
| `brandNewDays` / `recentDays` | what counts as brand-new / recent (defaults 7 / 90 days) |

### 3. Install the dashboard and start

```bash
# upload + install the application (files in app/)
curl -X PUT "$MASTER/api/hub/applications/web-investigator/versions/<version>" \
  -H 'Content-Type: application/json' --data-binary @app/web-investigator-<version>.application.json
curl -X POST "$MASTER/api/hub/install" -H 'Content-Type: application/json' \
  -d '{"source":"local","name":"web-investigator","version":"<version>","targetModelId":"my-research"}'
```

Start the lanes (per lane, or re-run install with `--start`), then open **Studio →
Applications** and — important — **select your model in the dropdown**; a fresh Studio session
defaults to another model and shows an empty list.

### 4. Feed it

Queue a few competitor URLs in the dashboard's **Queue URL** box (or drop tokens into
`p-scout-frontier`). The crawl follows links from there on its own, bounded by `maxDepth` and
deduped forever. Optionally add a search API key so **Queue query** can widen the crawl beyond
the link graph:

```
set_transition_credentials {transitionId: "t-scout-search",
                            credentials: {SEARCH_API_KEY: "..."}}
```

To onboard a **whole website** rather than one page, use **Add source** (or drop a
`{url: "https://the-site.example/"}` token into `p-scout-source-requests`), then press
**Harvest sitemaps**. The harvester reads the site's own sitemap — robots.txt first, then the
conventional locations — walks index files down to the article lists, and queues everything the
net doesn't already know. No API key needed; a site's sitemap lists *everything* it published,
which link-following alone never reaches. Runs are bounded (150 URLs per host, 300 per run by
default), and repeat runs continue where the last one stopped, so a large site drains over a few
runs (or the monthly schedule) instead of one expensive burst. Remember each harvested article
that passes the relevance gate costs one classification call — that bound is your cost lever.

## Using the dashboard, day to day

Open the app and read top-left to bottom-right — the **❓ How this works** card on the page
repeats all of this:

- **Coverage by category** — how much the competition has per category and age, and how much of
  it you already answer. Sorted by what's still open.
- **Fresh competitor articles** — everything they published recently, each row with a verdict
  (covered by you, or not) and three buttons: **Accept** (make it an article task, evidence
  attached), **Covered** (I already have this), **✕** (dismiss).
- **Latest analysis** — the written landscape analysis: what they're actually arguing right now,
  your position, the gaps, and recommendations you can **Accept as task** or **Dismiss**.
- **Article tasks** — everything you accepted. `draft ✓` means the writer has drafted it.
- **Drafts** — the written articles. Expand, **Copy markdown**, publish on your site, then click
  **Done** on the task.
- **Steer the crawl / Run buttons** — queue URLs and queries; **Add source** onboards a whole
  website (see below); *Run rollup* recomputes the analysis now; *Re-index own site* refreshes
  your inventory; *Crawl health* writes fetch diagnostics; *Re-crawl sources* re-visits known
  hosts' entry pages; *Harvest sitemaps* pulls sources' full article lists; *Draft article*
  writes the next accepted task immediately.

Buttons never execute anything themselves — they record a request token, and the net's own
lanes do the work. That's also why every click is auditable in the Decision log.

## What runs by itself

| When (Berlin) | What | Cost |
|---|---|---|
| Mon 05:45 | re-crawl known sources' entry pages | free (304s for unchanged pages) |
| Mon 06:15 | re-index your sitemap | free |
| daily 06:30 | rollup + fresh analysis | one model call |
| Mon 06:45 | crawl diagnostics | free |
| daily 07:00 | draft the oldest accepted task | one Claude Code run — only if something is accepted and undrafted |
| 1st of month 05:30 | sitemap harvest of all sources | free itself; each new article that passes the gate costs one classification call (capped at 300 URLs/run) |

The crawl itself is *not* scheduled — it runs when you feed it. The writer requires the
`claude` binary (Claude Code) on the executor host; a stopped API-model lane
(`t-scout-write`) exists as a fallback.

## Under the hood (the net)

```
frontier ─▶ fetch (script) ─▶ gate (free) ─▶ categorise (cheap model) ─▶ file by age
                │                                                            │
                └─▶ telemetry (every attempt)                brand-new / recent / archive
                                                                             │
your sitemap ─▶ owned index ─────────────────▶ taxonomy (script: counts + true gaps)
                                                                             │
                                                              analysis (model, facts only)
                                                                             │
        app: accept ─▶ tasks ─▶ writer (Claude Code, one draft per run) ─▶ drafts
```

Five scripts (`assets/`), sha256-pinned in the tool catalog and invoked by reference; two model
lanes (classify, analyse) plus the Claude Code writer; the rest is deterministic routing. The
dashboard (`app/`) is a `kind:"application"` package whose stores bind the same runtime places —
see `app/README.md` for how that works and how to rebuild the UI.

## Operating notes

- `p-scout-telemetry` records every fetch attempt with a closed-set `failureClass` — a failed
  scrape is diagnosable without re-crawling. Newest 500 kept automatically.
- The writer never drafts the same task twice, and one trigger produces at most one draft.
  A task is only ever closed by *you* clicking Done.
- Undated pages file as `archive` rather than claiming freshness they cannot prove.
- JS-rendered pages come back `empty-extract`; PDFs/feeds are `non-html` and skipped. There is
  no headless renderer here.
- Drafts are strong first versions, not fact-checked finals — review concrete values before
  publishing. That review is exactly what the accepted → Done gap is for.
