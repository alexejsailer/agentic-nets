#!/usr/bin/env python3
"""scout-health — roll telemetry up into actionable insights. Deterministic, no model.

Every fetch attempt writes one p-scout-telemetry token, success or failure. This turns
that log into observations with concrete suggestions, so scraping problems are
diagnosable without re-crawling and tuning is driven by evidence.

The net produces evidence; a human decides. Nothing here mutates the brief.
"""
import json, os, statistics
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
WINDOW = int(os.environ.get("WINDOW") or 1000)
MIN_HOST_ATTEMPTS = 3     # below this a host's failure rate is noise


def api(method, path, body=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def rows(place, limit):
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                  {"arcql": "FROM $ LIMIT %d" % limit, "limit": limit})
        return [(t.get("data") or {}) for t in (res.get("tokens") or [])]
    except Exception:
        return []


def num(v, default=0):
    """Token properties come back as STRINGS — parse before arithmetic."""
    try:
        return int(float(v))
    except Exception:
        return default


def main():
    tele = rows("p-scout-telemetry", WINDOW)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    insights = []

    def add(kind, metric, value, observation, suggestion):
        insights.append({"data": {"kind": kind, "metric": metric, "value": str(value),
                                  "observation": observation, "suggestion": suggestion,
                                  "sampleSize": str(len(tele)), "generatedAt": ts}})

    summary = {"telemetryRows": len(tele), "insights": 0, "ts": ts}
    if not tele:
        print(json.dumps(summary)); return

    outcomes = Counter(r.get("outcome", "?") for r in tele)
    classes = Counter(r.get("failureClass", "?") for r in tele)
    sources = Counter(r.get("dateSource", "?") for r in tele if r.get("outcome") == "ok")
    total = len(tele)
    ok = outcomes.get("ok", 0)

    add("rate", "fetchSuccessRate", "%.0f%%" % (100.0 * ok / total),
        "%d of %d attempts produced usable content." % (ok, total),
        "Below ~60% usually means the seed list or host filters need work."
        if ok / total < 0.6 else "Healthy.")

    # Failure-class histogram — the top class is where to invest.
    fails = Counter({k: v for k, v in classes.items() if k not in ("ok", "?")})
    if fails:
        top, n = fails.most_common(1)[0]
        hint = {
            "empty-extract": "JS-rendered pages. A headless renderer would be needed; "
                             "cheaper to drop these hosts.",
            "http-403-paywall": "Paywalled or bot-blocked. Add to brief.denyHosts.",
            "http-4xx": "Dead links. Likely a stale seed list.",
            "timeout": "Raise TIMEOUT or deny the slow host.",
            "http-429": "Rate limited. Slow the crawl or deny the host.",
            "non-html": "PDFs or feeds. Out of scope for this extractor.",
            "no-url": "Malformed frontier tokens.",
        }.get(top, "Inspect p-scout-telemetry for this class.")
        add("failure", "topFailureClass", "%s (%d)" % (top, n),
            "Most common failure is '%s', %d of %d attempts." % (top, n, total), hint)

    # Which date extractor wins — the single best guide to improving recency accuracy.
    # Counted over ARTICLES only: listing pages (site roots, /category/, /blog/) carry no
    # publication date by nature, and including them made this metric read 41% and demand a
    # fix that did not exist. Measured: 74 of 75 "undated" pages were listing pages.
    art = [r for r in tele if r.get("outcome") == "ok" and r.get("pageType") != "index"]
    art_sources = Counter(r.get("dateSource") for r in art)
    undated = art_sources.get("none", 0)
    if art:
        ok = len(art)
        sources = art_sources
        pct = 100.0 * undated / max(1, ok)
        add("dating", "undatedShare", "%.0f%%" % pct,
            "%d of %d ARTICLE fetches had no detectable publication date (listing pages excluded); "
            "those default to 'archive'. Winning extractors: %s."
            % (undated, ok, dict(sources)),
            "Above ~25% distorts the recency buckets — add a meta strategy for the "
            "dominant hosts." if pct > 25 else "Acceptable.")

    # Per-host reliability.
    by_host = defaultdict(lambda: [0, 0])
    for r in tele:
        h = r.get("host") or "?"
        by_host[h][0] += 1
        if r.get("outcome") == "ok":
            by_host[h][1] += 1
    bad = [(h, a, o) for h, (a, o) in by_host.items()
           if a >= MIN_HOST_ATTEMPTS and o == 0]
    for h, a, _ in sorted(bad, key=lambda x: -x[1])[:5]:
        add("host", "deadHost", h,
            "%s failed all %d attempts." % (h, a),
            'Add "%s" to brief.denyHosts to stop spending fetches on it.' % h)

    sizes = [num(r.get("extractChars")) for r in tele if r.get("outcome") == "ok"]
    if sizes:
        add("extraction", "medianExtractChars", int(statistics.median(sizes)),
            "Median usable text per page across %d fetches." % len(sizes),
            "Under ~800 chars suggests the extractor is missing the main content."
            if statistics.median(sizes) < 800 else "Reasonable article bodies.")

    idx = sum(1 for r in tele if r.get("outcome") == "ok" and r.get("pageType") == "index")
    okall = sum(1 for r in tele if r.get("outcome") == "ok")
    if okall:
        add("pages", "listingShare", "%.0f%%" % (100.0 * idx / okall),
            "%d of %d fetched pages are listing/index pages, not articles." % (idx, okall),
            "These are crawled for their links but must never be categorised — each one "
            "would cost a model call and file a fake competitor finding.")

    # Gate calibration — is minScore throwing away everything, or nothing?
    cand, rej = len(rows("p-scout-candidates", WINDOW)), len(rows("p-scout-rejected", WINDOW))
    if cand + rej:
        pass_pct = 100.0 * cand / (cand + rej)
        add("gate", "gatePassRate", "%.0f%%" % pass_pct,
            "%d passed, %d rejected by the deterministic score gate." % (cand, rej),
            "Under 5% means minScore is probably too high — sample p-scout-rejected "
            "for false negatives." if pass_pct < 5 else
            "Over 80% means the gate is barely filtering; raise minScore to cut model spend."
            if pass_pct > 80 else "Well calibrated.")

    if insights:
        try:
            api("POST", "/api/runtime/places/p-scout-insights/tokens/bulk?modelId=" + MODEL,
                {"tokens": insights})
            summary["insights"] = len(insights)
        except Exception as e:
            summary["error"] = str(e)[:200]

    summary["outcomes"] = dict(outcomes)
    summary["failureClasses"] = dict(fails) if fails else {}
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
