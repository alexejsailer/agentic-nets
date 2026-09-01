#!/usr/bin/env python3
"""scout-owned — index the OWNER'S OWN article inventory from their sitemap.

Deliberately NOT a crawler. It reads sitemap XML only: urls and lastmod, never page
bodies, and it writes to exactly one place (p-scout-owned). The owner's articles must
never enter the findings corpus — that is what `denyHosts` in the brief enforces on the
crawl side, and what this script's single write target enforces here. Without this
inventory the digest can only see COMPETITOR gaps and will happily recommend topics the
owner already ranks for; with it, `scout-taxonomy` can subtract what is already covered.

Replaces the whole place each run so a deleted post disappears from the inventory.
"""
import json, os, re
import urllib.request
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
OWNED_PLACE = "p-scout-owned"
MAX_SITEMAPS = 20
MAX_URLS = 2000
TIMEOUT = 25

LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)
LASTMOD = re.compile(r"<lastmod>\s*([^<\s]+)\s*</lastmod>", re.I)
URLBLOCK = re.compile(r"<url>(.*?)</url>", re.I | re.S)
SITEMAPBLOCK = re.compile(r"<sitemap>(.*?)</sitemap>", re.I | re.S)
STOP = set("""a an the and or for to of in on with your you how what why when is are do does can
will vs best top guide review reviews com www html htm index page""".split())


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "agenticos-scout-owned/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "replace")


def slug_of(url):
    return url.rstrip("/").split("/")[-1].lower()


def terms_of(text):
    return sorted({w for w in re.split(r"[^a-z0-9]+", text.lower()) if w and w not in STOP and len(w) > 2})


def brief():
    try:
        res = api("POST", "/api/runtime/places/p-scout-brief/tokens/query?modelId=" + MODEL,
                  {"arcql": "FROM $ LIMIT 1", "limit": 1})
        return (res.get("tokens") or [{}])[0].get("data") or {}
    except Exception:
        return {}


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    b = brief()
    root = os.environ.get("OWN_SITEMAP") or b.get("ownSitemap") or ""
    out = {"kind": "owned-index", "ts": ts, "sitemap": root, "indexed": 0}
    if not root:
        out["error"] = "no ownSitemap in brief and no OWN_SITEMAP env"
        print(json.dumps(out)); return

    # A sitemap index points at child sitemaps; a plain sitemap holds <url> entries.
    try:
        first = fetch(root)
    except Exception as e:
        out["error"] = "fetch failed: %s" % str(e)[:120]
        print(json.dumps(out)); return

    docs, children = [first], []
    if SITEMAPBLOCK.search(first):
        for block in SITEMAPBLOCK.findall(first)[:MAX_SITEMAPS]:
            m = LOC.search(block)
            if m:
                children.append(m.group(1))
        docs = []
        for c in children:
            try:
                docs.append(fetch(c))
            except Exception:
                continue
    out["childSitemaps"] = len(children)

    seen, rows = set(), []
    root_host = root.split("/")[2].lower() if "//" in root else ""
    for doc in docs:
        for block in URLBLOCK.findall(doc):
            m = LOC.search(block)
            if not m:
                continue
            url = m.group(1).strip()
            if url in seen:
                continue
            seen.add(url)
            slug = slug_of(url)
            # The bare homepage carries no topic; keep the inventory to real articles.
            if not slug or slug == root_host:
                continue
            lm = LASTMOD.search(block)
            rows.append({
                "url": url, "slug": slug,
                "terms": json.dumps(terms_of(slug)),
                "lastmod": (lm.group(1)[:10] if lm else ""),
                "indexedAt": ts, "source": "sitemap",
            })
            if len(rows) >= MAX_URLS:
                break

    try:
        api("POST", "/api/runtime/places/%s/tokens/deleteAll?modelId=%s" % (OWNED_PLACE, MODEL))
        for i in range(0, len(rows), 100):
            api("POST", "/api/runtime/places/%s/tokens/bulk?modelId=%s" % (OWNED_PLACE, MODEL),
                {"tokens": [{"data": r} for r in rows[i:i + 100]]})
    except Exception as e:
        out["error"] = str(e)[:200]

    out["indexed"] = len(rows)
    if rows:
        out["newestLastmod"] = max((r["lastmod"] for r in rows), default="")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
