#!/usr/bin/env python3
"""scout-taxonomy — deterministic rollup of findings into a category structure.

Computes EVERY number the digest will quote: per-category counts, the recency split,
per-competitor coverage, and which category/competitor cells are empty. The agent that
writes the analysis gets these as facts and is told not to recount — an agent asked to
both count and interpret fabricates the counts.

Writes one token per category to p-scout-taxonomy, plus a single `facts` token that is
the digest lane's whole input.

The facts token also carries the FULL TEXT of the fresh findings (brand-new + recent),
pulled from the blobs the fetch script already stored. Counts tell you how much a
competitor publishes; only the text tells you what they actually said, which is what a
"what should I write next" answer turns on. Text is bounded per article and in total so
one long page cannot crowd out the rest.
"""
import json, os, re
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
BUCKETS = {"brand-new": "p-find-brand-new", "recent": "p-find-recent", "archive": "p-find-archive"}
TOP_TITLES = 3
BLOBS = os.environ.get("BLOB_URL", "http://127.0.0.1:8090").rstrip("/")
FRESH_RECENCIES = ("brand-new", "recent")   # what "actively publishing" means here
FRESH_MAX_ARTICLES = 12                      # bound the fan-out; freshness is a short list by design
FRESH_CHARS = 2500                           # per article
FRESH_TOTAL_CHARS = 26000                    # hard ceiling for the whole bundle


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def rows(place, limit=2000):
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                  {"arcql": "FROM $ LIMIT %d" % limit, "limit": limit})
        return [(t.get("data") or {}) for t in (res.get("tokens") or [])]
    except Exception:
        return []


SENTENCE = re.compile(r"[A-Z][^.!?]{60,}?[.!?](?:\s|$)")


def article_body(text, title):
    """Drop site chrome. Nav menus are short label fragments; prose has long sentences, so
    the first real sentence is the body start. Prefer one at or after the last echo of the
    title, since the article H1 sits directly above its own text. Without this the leading
    ~320 chars of repeated menu would eat into every article's budget."""
    start = 0
    key = " ".join((title or "").split()[:6])
    if key and len(key) > 12:
        i = text.rfind(key)
        if 0 <= i < len(text) * 0.6:
            start = i
    m = SENTENCE.search(text, start) or SENTENCE.search(text)
    return text[m.start():] if m else text


def blob_text(urn):
    """Fetch stored article text by URN. The fetch script prefixes a
    'URL/TITLE/PUBLISHED' header before a blank line; strip it so the model sees prose."""
    if not urn or "blob:" not in urn:
        return ""
    try:
        with urllib.request.urlopen(BLOBS + "/api/blobs/" + urn.split("blob:", 1)[1], timeout=20) as r:
            raw = r.read().decode("utf-8", "replace")
    except Exception:
        return ""
    body = raw.split("\n\n", 1)[1] if "\n\n" in raw[:400] else raw
    return " ".join(body.split())


def host_of(url):
    try:
        return url.split("/")[2].lower().replace("www.", "")
    except Exception:
        return "?"


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    findings = []
    for recency, place in BUCKETS.items():
        for d in rows(place):
            d["_recency"] = recency
            findings.append(d)

    summary = {"findings": len(findings), "categories": 0, "competitors": 0, "ts": ts}
    if not findings:
        print(json.dumps(summary)); return

    by_cat = defaultdict(list)
    for f in findings:
        by_cat[(f.get("category") or "uncategorised").strip().lower()].append(f)

    hosts = Counter(host_of(f.get("url", "")) for f in findings)
    cat_tokens, cat_facts = [], []
    for cat, items in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
        split = Counter(i["_recency"] for i in items)
        cat_hosts = Counter(host_of(i.get("url", "")) for i in items)
        fact = {
            "category": cat,
            "total": len(items),
            "brandNew": split.get("brand-new", 0),
            "recent": split.get("recent", 0),
            "archive": split.get("archive", 0),
            "competitors": dict(cat_hosts),
            "examples": [str(i.get("title") or i.get("url"))[:110] for i in items[:TOP_TITLES]],
        }
        cat_facts.append(fact)
        cat_tokens.append({"data": {**fact,
                                    "competitors": json.dumps(dict(cat_hosts)),
                                    "examples": json.dumps(fact["examples"]),
                                    "generatedAt": ts}})

    # Per-competitor coverage, and the cells nobody has filled — the gap list is the
    # single most useful output of a competitor analysis, so compute it here rather
    # than hoping the model notices an absence.
    per_host = {}
    for h in hosts:
        hf = [f for f in findings if host_of(f.get("url", "")) == h]
        per_host[h] = {
            "articles": len(hf),
            "categories": sorted({(f.get("category") or "uncategorised").lower() for f in hf}),
            "brandNew": sum(1 for f in hf if f["_recency"] == "brand-new"),
            "recent": sum(1 for f in hf if f["_recency"] == "recent"),
        }
    all_cats = sorted(by_cat.keys())
    gaps = []
    for h, info in per_host.items():
        missing = [c for c in all_cats if c not in info["categories"]]
        if missing:
            gaps.append({"competitor": h, "notCovering": missing})

    # Fresh full text: the evidence behind the freshness numbers. Newest first, so a
    # truncated bundle still contains the most recent competitor moves.
    fresh_rows = sorted(
        [f for f in findings if f.get("_recency") in FRESH_RECENCIES],
        key=lambda f: str(f.get("publishedAt") or ""), reverse=True)
    fresh_articles, used, skipped = [], 0, 0
    for f in fresh_rows[:FRESH_MAX_ARTICLES]:
        text = article_body(blob_text(f.get("blobUrn", "")), f.get("title", ""))
        if not text:
            skipped += 1
            continue
        room = min(FRESH_CHARS, FRESH_TOTAL_CHARS - used)
        if room < 400:
            skipped += 1
            continue
        clipped = text[:room]
        used += len(clipped)
        fresh_articles.append({
            "url": f.get("url", ""), "title": f.get("title", ""),
            "publishedAt": f.get("publishedAt", ""), "recency": f["_recency"],
            "category": (f.get("category") or "").lower(), "host": host_of(f.get("url", "")),
            "truncated": len(clipped) < len(text), "text": clipped,
        })

    facts = {
        "kind": "facts",
        "generatedAt": ts,
        "totalFindings": len(findings),
        "recencySplit": {r: sum(1 for f in findings if f["_recency"] == r) for r in BUCKETS},
        "categoryCount": len(by_cat),
        "categories": cat_facts,
        "competitors": per_host,
        "coverageGaps": gaps,
        "freshTextArticles": len(fresh_articles),
        "freshTextSkipped": skipped,
    }

    try:
        api("POST", "/api/runtime/places/p-scout-taxonomy/tokens/deleteAll?modelId=" + MODEL)
        if cat_tokens:
            api("POST", "/api/runtime/places/p-scout-taxonomy/tokens/bulk?modelId=" + MODEL,
                {"tokens": cat_tokens})
        # The digest lane binds exactly this token; everything it needs is inside it as
        # one JSON string, so the agent needs no extra queries.
        api("POST", "/api/runtime/places/p-scout-taxonomy/tokens?modelId=" + MODEL,
            {"name": "facts", "data": {"kind": "facts", "generatedAt": ts,
                                       "factsJson": json.dumps(facts),
                                       # Kept separate from factsJson: numbers are measured,
                                       # this is evidence. The digest cites them differently.
                                       "freshTextJson": json.dumps(fresh_articles),
                                       "freshTextArticles": len(fresh_articles),
                                       "freshTextChars": used,
                                       "totalFindings": len(findings),
                                       "categoryCount": len(by_cat),
                                       "competitorCount": len(per_host)}})
    except Exception as e:
        summary["error"] = str(e)[:200]

    summary.update(categories=len(by_cat), competitors=len(per_host),
                   recencySplit=facts["recencySplit"],
                   freshTextArticles=len(fresh_articles), freshTextChars=used,
                   freshTextSkipped=skipped)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
