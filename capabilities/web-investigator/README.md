# Web Investigator

Point it at seed URLs and a brief. It crawls, dates, scores, categorises and analyses — and every
number in the output is measured, not written by a model.

## What it does

```
brief + seed URLs
      │
      ▼
  fetch (script, executor)      conditional GET, extract text/links/date, score relevance,
      │                         classify listing-vs-article, blobstore the text, queue new links
      ▼
  gate (map, free)              only articles above minScore reach a model
      │
      ▼
  categorise (agent, cheap)     one classification per surviving article
      │
      ▼
  route by recency              brand-new (≤7d) / recent (≤90d) / archive
      │
      ▼
  taxonomy (script)             per-category and per-source counts, explicit coverage gaps
      │
      ▼
  analysis (agent)              interprets those facts — and only those
```

**The split is the whole design.** Deterministic code does the fetching, dating, scoring, dedupe,
link discovery and every count. Exactly two agent lanes exist: one classifies an article, one
writes the analysis. An agent asked to both count and interpret will fabricate the counts.

## Install

```bash
export AGENTICOS_MCP_URL=http://127.0.0.1:8091/mcp
export AGENTICOS_MCP_TOKEN=<your mcp token>

node capabilities/tools/pack.mjs install \
  --dir capabilities/web-investigator \
  --model my-research \
  --session agent-web-investigator
```

The installer registers the three scripts into the target model's local tool catalog **before**
wiring the nets — a command lane invokes by `toolId`, which resolves per-model, so nets installed
without their scripts look healthy and fail on first fire.

**Install does not go live.** Lanes land DEPLOYED but stopped, because the brief ships as a
REPLACE-ME template and starting an agent lane against placeholder config is not a useful default.
Configure the brief first, then start — either per lane, or re-run install with `--start`.

## Then make it yours

The pack ships **no domain**. `seeds/p-scout-brief.json` is a REPLACE-ME template; edit the brief
token in `p-scout-brief` and the whole net retargets without touching a lane:

| Field | What it drives |
|---|---|
| `topic`, `description` | handed to the analysis agent verbatim |
| `domainHint` | vocabulary that helps the classifier |
| `categories` | the closed list the classifier must choose from |
| `mustInclude` / `mustExclude` | the free relevance score |
| `minScore` | how much reaches a model — the main cost lever |
| `denyHosts` | sites never to crawl (e.g. your own) |
| `maxDepth` | crawl depth cap |
| `brandNewDays` / `recentDays` | the recency bucket boundaries |

Seed work by writing URL tokens into `p-scout-frontier`:
`{url, depth: 0, attempt: 0, briefId, queuedAt}`.

**To crawl wider than your seeds reach**, add a search key and write queries into
`p-scout-queries` (`{query, maxResults}`). Hits enter the frontier at depth 0 and go through
exactly the same dedupe, host filters and depth budget as discovered links:

```
set_transition_credentials {transitionId: "t-scout-search",
                            credentials: {SEARCH_API_KEY: "..."}}
```

Provider comes from `brief.searchProvider` — `brave`, `tavily` or `serper`. Without a key the
net still runs on seeds plus link-following; the search lane fails loudly rather than
returning zero hits, because "no credential" and "no results" must not look alike.

Read the analysis from `p-scout-digest`. Re-run `t-scout-taxonomy-cmd` → `t-scout-taxonomy` any
time to refresh it over everything filed so far.

## Operating it

- `p-scout-telemetry` gets one row per fetch attempt, success or failure, with a closed-set
  `failureClass` and the `dateSource` that won. A failed scrape is diagnosable without re-crawling.
  The place keeps its newest 500 rows (`retain: 500` on the lift lane) — housekeeping is built in,
  no reaper lane needed. The digest place keeps its last 3 analyses the same way.
- `t-scout-health` rolls that into `p-scout-insights` with concrete suggestions — dead hosts to
  deny, whether `minScore` is calibrated, how much of the crawl is listing pages.
- Nothing is scheduled. Lanes run when started; arm a cron only once you have measured the cost.

## Cost

Per article: one classification on a cheap model. Per run: one synthesis. Everything else is free.
The gate is what keeps it cheap — in one measured run 48 of 148 fetched pages were listing pages
and never reached a model at all. `capabilityProfile: research-worker` keeps each agent fire from
shipping the full tool preamble.

## Known edges

- Undated pages default to `archive` rather than claiming a freshness they cannot prove.
  `undatedShare` in the insights tells you whether that is distorting the picture.
- JS-rendered pages come back as `empty-extract`. There is no headless renderer here.
- PDFs and feeds are classified `non-html` and skipped.
