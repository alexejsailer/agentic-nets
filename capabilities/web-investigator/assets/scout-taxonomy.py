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
# Fresh evidence is COMPACT: every fresh finding goes in as a card (the summary and key points
# written at classification time), and only the newest few also carry clipped body text. The
# analyst sees the whole fresh field instead of twelve bodies, for fewer tokens.
FRESH_MAX_CARDS = 40
FRESH_TEXT_ARTICLES = 6
FRESH_CHARS = 1800                           # per article body
FRESH_TOTAL_CHARS = 12000                    # hard ceiling for all body text
# A fallback answer from the analysis lane (no DONE call) is filed to p-scout-errors by the
# retry lane, which re-issues this rollup. Bounded: after this many fallbacks in one day the
# facts token is withheld, so a model that will not follow the contract cannot burn all night.
MAX_ANALYSIS_RETRIES = 3
ERRORS_PLACE = "p-scout-errors"
OWNED_PLACE = "p-scout-owned"                # the owner's OWN inventory (slugs, never crawled)
SOURCES_PLACE = "p-scout-sources"            # one profile token per host (replaced per run)
GROWTH_PLACE = "p-scout-growth"              # append-only expansion snapshots
GROWTH_KEEP = 120                            # ~4 months of daily snapshots
# Host-rule subset of the fetch script's detector: enough to backfill findings fetched before
# sourceType existed, using only their URL (no HTML available at rollup time).
SOURCE_HOSTS = [
    (("reddit.com", "redd.it", "stackexchange.com", "stackoverflow.com", "quora.com"), "forum"),
    (("twitter.com", "x.com", "facebook.com", "instagram.com", "linkedin.com", "tiktok.com",
      "pinterest.com", "bsky.app", "threads.net"), "social"),
    (("youtube.com", "youtu.be", "vimeo.com", "rumble.com"), "video"),
    (("amazon.", "ebay.", "walmart.", "homedepot.", "lowes.", "etsy.", "aliexpress."), "commercial"),
    (("wikipedia.org", "wikihow.com"), "docs"),
    (("medium.com", "substack.com", "blogspot.", "wordpress.com", "tumblr.com"), "blog"),
]


def source_type_of(finding):
    st = (finding.get("sourceType") or "").strip().lower()
    if st:
        return st
    url = finding.get("url", "")
    host = host_of(url)
    for hosts, kind in SOURCE_HOSTS:
        if any(h in host for h in hosts):
            return kind
    path = url.split(host, 1)[-1].lower() if host else url.lower()
    if any(seg in path for seg in ("/forum", "/forums", "/community/", "/thread", "/topic/")):
        return "forum"
    return "blog"  # crawled-article default; the fetch-time detector refines new findings
OWN_MATCH = 0.18                             # Jaccard on slug/title terms; tuned on a real 79-post site
OWN_GAP_EXAMPLES = 8                         # uncovered titles surfaced per category


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


def key_points(v):
    """keyPoints arrive as a JSON string (node stores properties as strings) or a list."""
    if isinstance(v, list):
        return [str(x)[:160] for x in v][:5]
    try:
        parsed = json.loads(v or "[]")
        return [str(x)[:160] for x in parsed][:5] if isinstance(parsed, list) else [str(parsed)[:160]]
    except Exception:
        return [x.strip()[:160] for x in str(v or "").split(";") if x.strip()][:5]


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


OWN_STOP = set("""a an the and or for to of in on with your you how what why when is are do does can
will vs best top guide review reviews com www html htm index page""".split())
# "Some Title - ExampleSite.com" — the site-name suffix is pure noise for matching and, if
# hardcoded, would make this script domain-specific. Strip it structurally instead.
TITLE_SUFFIX = re.compile(r"\s*[-|\u2013\u2014]\s*[^-|\u2013\u2014]{0,40}\.(com|net|org|co|io)\s*$", re.I)


def own_terms(text, host=""):
    text = TITLE_SUFFIX.sub("", text or "")
    stop = set(OWN_STOP)
    # Host words are shared by every finding from that site, so they inflate every score.
    stop.update(w for w in re.split(r"[^a-z0-9]+", (host or "").lower()) if len(w) > 2)
    return {w for w in re.split(r"[^a-z0-9]+", text.lower()) if w and w not in stop and len(w) > 2}


def corpus_stopwords(docs, ratio=0.35):
    """Terms appearing in a large share of the corpus carry no discriminating power: whatever
    noun the brief is about will occur in nearly every title and slug. Deriving those terms
    instead of listing them is what keeps this script reusable — hardcoding the topic word
    would work for one tenant and silently break the next. Without it, every title matches
    every slug and the gap list collapses to nothing."""
    if not docs:
        return set()
    df = Counter()
    for terms in docs:
        df.update(set(terms))
    cutoff = max(2, int(len(docs) * ratio))
    return {w for w, n in df.items() if n >= cutoff}


def best_own_match(terms, owned):
    """Closest owned article by term overlap. Deliberately crude and deterministic: the point
    is 'do I already have something on this?', not semantic similarity — and a model asked to
    judge that for 126 findings would cost more than the whole crawl."""
    best, who = 0.0, None
    if not terms:
        return 0.0, None
    for slug, oterms in owned:
        if not oterms:
            continue
        j = len(terms & oterms) / len(terms | oterms)
        if j > best:
            best, who = j, slug
    return best, who


def host_of(url):
    try:
        return url.split("/")[2].lower().replace("www.", "")
    except Exception:
        return "?"


def tokens_with_meta(place, limit=2000):
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                  {"arcql": "FROM $ LIMIT %d" % limit, "limit": limit})
        return res.get("tokens") or []
    except Exception:
        return []


def recency_for(published, brand_days, recent_days):
    if not published:
        return "archive"
    try:
        dt = datetime.strptime(str(published)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:
        return "archive"
    age = max(0, (datetime.now(timezone.utc) - dt).days)
    return "brand-new" if age <= brand_days else ("recent" if age <= recent_days else "archive")


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    brief0 = (rows("p-scout-brief") or [{}])[0]
    brand_days = int(brief0.get("brandNewDays") or 7)
    recent_days = int(brief0.get("recentDays") or 90)

    # RE-BUCKET FIRST: recency was stamped at filing time and findings age in place — without
    # this, a "brand-new" bucket quietly fills with month-old articles and every freshness
    # number downstream lies. Move = create in the right bucket, then delete the original.
    moved = 0
    for recency, place in BUCKETS.items():
        for tok in tokens_with_meta(place):
            d = tok.get("data") or {}
            want = recency_for(d.get("publishedAt"), brand_days, recent_days)
            if want == recency:
                continue
            clean = {k: v for k, v in d.items() if not k.startswith("_")}
            try:
                api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (BUCKETS[want], MODEL),
                    {"name": tok.get("name"), "data": clean})
                api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s"
                    % (place, tok.get("id"), MODEL))
                moved += 1
            except Exception:
                continue

    findings = []
    for recency, place in BUCKETS.items():
        for d in rows(place):
            d["_recency"] = recency
            findings.append(d)

    # Own inventory: what the OWNER already published. Without it every "gap" below is a
    # competitor gap, which is not the same question as "what should I write next".
    owned = []
    for d in rows(OWNED_PLACE):
        try:
            t = set(json.loads(d.get("terms") or "[]"))
        except Exception:
            t = own_terms(d.get("slug", ""))
        owned.append((d.get("slug", ""), t))

    summary = {"findings": len(findings), "categories": 0, "competitors": 0,
               "ownArticles": len(owned), "rebucketed": moved, "ts": ts}
    if not findings:
        print(json.dumps(summary)); return

    # Derive the corpus-wide filler terms from BOTH sides, then re-tokenise through them.
    raw_find = [(f, own_terms(f.get("title") or f.get("url", ""), host_of(f.get("url", "")))) for f in findings]
    filler = corpus_stopwords([t for _, t in raw_find] + [t for _, t in owned])
    owned = [(slug, t - filler) for slug, t in owned]
    for f, terms in raw_find:
        score, who = best_own_match(terms - filler, owned)
        f["_ownScore"], f["_ownMatch"] = round(score, 2), who
        f["_covered"] = score >= OWN_MATCH
    for f in findings:
        f["_sourceType"] = source_type_of(f)

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
            "ownCovered": sum(1 for i in items if i["_covered"]),
            "ownUncovered": sum(1 for i in items if not i["_covered"]),
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
    # Source profiles: one token per host — the provenance table and the expansion evidence.
    src_profiles = []
    for h in sorted(hosts):
        hf = [f for f in findings if host_of(f.get("url", "")) == h]
        stypes = Counter(f["_sourceType"] for f in hf)
        seen = sorted(str(f.get("filedAt") or f.get("_emittedAt") or "") for f in hf if (f.get("filedAt") or f.get("_emittedAt")))
        src_profiles.append({
            "host": h, "sourceType": stypes.most_common(1)[0][0] if stypes else "other",
            "articles": len(hf),
            "brandNew": sum(1 for f in hf if f["_recency"] == "brand-new"),
            "recent": sum(1 for f in hf if f["_recency"] == "recent"),
            "categories": len({(f.get("category") or "?").lower() for f in hf}),
            "firstSeenAt": (seen[0][:10] if seen else ""),
            "lastSeenAt": (seen[-1][:10] if seen else ""),
        })
    by_type = Counter(f["_sourceType"] for f in findings)
    try:
        api("POST", "/api/runtime/places/%s/tokens/deleteAll?modelId=%s" % (SOURCES_PLACE, MODEL))
        if src_profiles:
            api("POST", "/api/runtime/places/%s/tokens/bulk?modelId=%s" % (SOURCES_PLACE, MODEL),
                {"tokens": [{"data": {**p, "generatedAt": ts}} for p in src_profiles]})
    except Exception:
        pass

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
    fresh_articles, used, skipped, with_text = [], 0, 0, 0
    for i, f in enumerate(fresh_rows[:FRESH_MAX_CARDS]):
        card = {
            "url": f.get("url", ""), "title": f.get("title", ""),
            "publishedAt": f.get("publishedAt", ""), "recency": f["_recency"],
            "category": (f.get("category") or "").lower(), "host": host_of(f.get("url", "")),
            "summary": str(f.get("summary") or "")[:400], "keyPoints": key_points(f.get("keyPoints")),
            "coveredByOwn": f["_covered"], "closestOwnSlug": f["_ownMatch"], "ownScore": f["_ownScore"],
        }
        if i < FRESH_TEXT_ARTICLES:
            text = article_body(blob_text(f.get("blobUrn", "")), f.get("title", ""))
            room = min(FRESH_CHARS, FRESH_TOTAL_CHARS - used)
            if text and room >= 400:
                clipped = text[:room]
                used += len(clipped)
                with_text += 1
                card.update(text=clipped, truncated=len(clipped) < len(text))
            else:
                skipped += 1
        fresh_articles.append(card)

    facts = {
        "kind": "facts",
        "generatedAt": ts,
        "totalFindings": len(findings),
        "recencySplit": {r: sum(1 for f in findings if f["_recency"] == r) for r in BUCKETS},
        "categoryCount": len(by_cat),
        "categories": cat_facts,
        "competitors": per_host,
        "coverageGaps": gaps,
        "freshCards": len(fresh_articles),
        "freshTextArticles": with_text,
        "freshTextSkipped": skipped,
        "sources": {
            "hosts": src_profiles,
            "byType": dict(by_type),
            "note": "Provenance of the corpus: what KIND of place each finding came from. A gap "
                    "confirmed across independent source types is stronger evidence than volume "
                    "from one blog.",
        },
        "ownInventory": {
            "articles": len(owned),
            "note": "The owner's OWN published slugs. A category with high ownCovered is ALREADY "
                    "served by the owner — recommending it is a wasted recommendation.",
        },
        # The actual answer to "what should I write next": competitor material with no
        # near-equivalent on the owner's site, newest first within each category.
        "trueGaps": [
            {
                "category": cat,
                "uncovered": sum(1 for i in items if not i["_covered"]),
                "ofTotal": len(items),
                "examples": [
                    {"title": str(i.get("title") or i.get("url"))[:110], "recency": i["_recency"]}
                    for i in sorted(items, key=lambda x: (x["_recency"] != "brand-new",
                                                          x["_recency"] != "recent"))
                    if not i["_covered"]
                ][:OWN_GAP_EXAMPLES],
            }
            for cat, items in sorted(by_cat.items(), key=lambda kv: -sum(1 for i in kv[1] if not i["_covered"]))
            if any(not i["_covered"] for i in items) and cat != "unrelated"
        ],
    }

    # Growth snapshot: the expansion evidence, appended every run. newFindings/newHosts are
    # diffs against the previous snapshot, so the series reads as "what did watching buy us".
    import hashlib
    prev = sorted(rows(GROWTH_PLACE), key=lambda g: str(g.get("ts") or ""))
    last = prev[-1] if prev else {}
    corpus_hash = hashlib.sha256(json.dumps(
        {"cats": {c["category"]: c["total"] for c in cat_facts},
         "rec": facts["recencySplit"], "own": len(owned), "hosts": sorted(hosts)},
        sort_keys=True).encode()).hexdigest()[:16]
    snapshot = {
        "kind": "growth", "ts": ts,
        "findings": len(findings), "hosts": len(hosts), "ownArticles": len(owned),
        "byType": json.dumps(dict(by_type)),
        "recencySplit": json.dumps(facts["recencySplit"]),
        "newFindings": max(0, len(findings) - int(last.get("findings") or 0)),
        "newHosts": max(0, len(hosts) - int(last.get("hosts") or 0)),
        "corpusHash": corpus_hash,
    }
    try:
        api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (GROWTH_PLACE, MODEL),
            {"name": "growth-" + ts.replace(":", ""), "data": snapshot})
        extra = sorted(rows(GROWTH_PLACE), key=lambda g: str(g.get("ts") or ""))
        # keep the series bounded without a retain postset (this place has no producing lane)
        for g in extra[:-GROWTH_KEEP]:
            pass  # deleteAll-free trim would need ids; the place grows ~1/day, fine for months
    except Exception:
        pass

    # Skip the ANALYSIS when nothing changed: an unchanged corpus re-analysed daily is a
    # model call for zero new information. The category tokens and profiles above are always
    # refreshed (free); only the facts token — the digest lane's trigger — is withheld.
    unchanged = (last.get("corpusHash") == corpus_hash)
    digest_recent = False
    if unchanged:
        try:
            digs = rows("p-scout-digest")
            newest = max((str(d.get("generatedAt") or "") for d in digs), default="")
            digest_recent = newest >= (datetime.now(timezone.utc)
                                       .strftime("%Y-%m-%dT%H:%M:%SZ"))[:8] + "01"
            # crude week guard: newest within this month and corpus unchanged -> skip
            from datetime import timedelta
            week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
            digest_recent = newest >= week_ago
        except Exception:
            digest_recent = False
    # A retry lane re-issues this rollup after the analysis lane answered without DONE. That
    # run exists precisely because the CURRENT corpus has no analysis, so the unchanged/fresh
    # rule must not swallow it; only the daily bound may.
    retry_reason = (os.environ.get("RETRY_REASON") or "").strip()
    forced = bool(retry_reason and retry_reason.lower() not in ("null", "none"))
    fallbacks_today = sum(1 for e in rows(ERRORS_PLACE)
                          if e.get("reason") == "analysis-fallback"
                          and str(e.get("filedAt") or "")[:10] == ts[:10])
    exhausted = fallbacks_today >= MAX_ANALYSIS_RETRIES
    skip_digest = exhausted or (not forced and unchanged and digest_recent)
    summary["analysisFallbacksToday"] = fallbacks_today
    if forced:
        summary["retryReason"] = retry_reason

    try:
        api("POST", "/api/runtime/places/p-scout-taxonomy/tokens/deleteAll?modelId=" + MODEL)
        if cat_tokens:
            api("POST", "/api/runtime/places/p-scout-taxonomy/tokens/bulk?modelId=" + MODEL,
                {"tokens": cat_tokens})
        if skip_digest:
            summary["digest"] = (("skipped: analysis fell back %d times today; no more re-runs "
                                  "until tomorrow" % fallbacks_today) if exhausted
                                 else "skipped: corpus unchanged and analysis fresh (<7d)")
            raise StopIteration  # jump past the facts write; category tokens are already in
        # The digest lane binds exactly this token; everything it needs is inside it as
        # one JSON string, so the agent needs no extra queries.
        api("POST", "/api/runtime/places/p-scout-taxonomy/tokens?modelId=" + MODEL,
            {"name": "facts", "data": {"kind": "facts", "generatedAt": ts,
                                       "factsJson": json.dumps(facts),
                                       # Kept separate from factsJson: numbers are measured,
                                       # this is evidence. The digest cites them differently.
                                       "freshTextJson": json.dumps(fresh_articles),
                                       "freshCards": len(fresh_articles),
                                       "freshTextArticles": with_text,
                                       "freshTextChars": used,
                                       "ownArticles": len(owned),
                                       "ownUncovered": sum(1 for f in findings if not f["_covered"]),
                                       "totalFindings": len(findings),
                                       "categoryCount": len(by_cat),
                                       "competitorCount": len(per_host)}})
    except StopIteration:
        pass
    except Exception as e:
        summary["error"] = str(e)[:200]

    summary.update(sourcesByType=dict(by_type),
                   categories=len(by_cat), competitors=len(per_host),
                   recencySplit=facts["recencySplit"],
                   freshCards=len(fresh_articles),
                   freshTextArticles=with_text, freshTextChars=used,
                   freshTextSkipped=skipped, ownArticles=len(owned),
                   ownCovered=sum(1 for f in findings if f["_covered"]),
                   ownUncovered=sum(1 for f in findings if not f["_covered"]))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
