#!/usr/bin/env python3
"""scout-taxonomy — deterministic rollup of findings into a category structure.

Computes EVERY number the digest will quote: per-category counts, the recency split,
per-competitor coverage, and which category/competitor cells are empty. The agent that
writes the analysis gets these as facts and is told not to recount — an agent asked to
both count and interpret fabricates the counts.

Writes one token per category to p-scout-taxonomy, plus a single `facts` token that is
the digest lane's whole input.
"""
import json, os
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
BUCKETS = {"brand-new": "p-find-brand-new", "recent": "p-find-recent", "archive": "p-find-archive"}
TOP_TITLES = 3


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

    facts = {
        "kind": "facts",
        "generatedAt": ts,
        "totalFindings": len(findings),
        "recencySplit": {r: sum(1 for f in findings if f["_recency"] == r) for r in BUCKETS},
        "categoryCount": len(by_cat),
        "categories": cat_facts,
        "competitors": per_host,
        "coverageGaps": gaps,
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
                                       "totalFindings": len(findings),
                                       "categoryCount": len(by_cat),
                                       "competitorCount": len(per_host)}})
    except Exception as e:
        summary["error"] = str(e)[:200]

    summary.update(categories=len(by_cat), competitors=len(per_host),
                   recencySplit=facts["recencySplit"])
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
