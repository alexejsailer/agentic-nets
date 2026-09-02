#!/usr/bin/env python3
"""scout-sitemap — onboard a website by harvesting its own index of itself.

Link-following only reaches what the crawled pages happen to link; a site's sitemap lists
EVERYTHING it published. For each source host this script DISCOVERS the sitemap (robots.txt
`Sitemap:` lines first, then the conventional locations), walks index files down to the
article lists, filters out the obvious non-articles, drops everything the registry already
knows, and queues the rest into the frontier — where the ordinary fetch/gate/classify
machinery takes over. Nothing downstream changes; this only widens where URLs come from.

Hosts come from three places, deniest first: explicit onboarding requests
(p-scout-source-requests, consumed after processing), the rollup's host profiles
(p-scout-sources), and finding hosts as a fallback. brief.denyHosts is honoured — the
owner's site is indexed by scout-owned, never crawled.

Caps are deliberate: a first harvest of a mature site is the one genuinely expensive crawl
this net ever runs (every article that passes the gate costs one classification call), so
URLS_PER_HOST / MAX_TOTAL bound each run and the registry makes re-runs incremental.
"""
import json, os, re
import urllib.request
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
SITE = (os.environ.get("SITE") or "").strip()          # optional: harvest ONE site only


def env_int(key, default):
    # Template interpolation renders a missing field as the string 'null' — never crash on it.
    try:
        return int(os.environ.get(key) or default)
    except (TypeError, ValueError):
        return default


URLS_PER_HOST = env_int("URLS_PER_HOST", 150)
MAX_TOTAL = env_int("MAX_TOTAL", 300)
MAX_CHILD_SITEMAPS = 10
TIMEOUT = 25
UA = "agenticos-scout-sitemap/1.0"

SITEMAP_CANDIDATES = ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap-index.xml")
CHILD_PREFER = ("post", "article", "blog", "news", "stories")
CHILD_EXCLUDE = ("image", "video", "category", "tag", "author", "attachment", "product-cat",
                 "page-sitemap", "misc", "local", "web-stories")
URL_EXCLUDE_SUFFIX = (".xml", ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".zip", ".mp4")
LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)
IS_INDEX = re.compile(r"<\s*sitemapindex", re.I)


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def tokens_meta(place, limit=5000):
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                  {"arcql": "FROM $ LIMIT %d" % limit, "limit": limit})
        return res.get("tokens") or []
    except Exception:
        return []


def rows(place, limit=5000):
    return [(t.get("data") or {}) for t in tokens_meta(place, limit)]


def fetch_text(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
        if raw[:2] == b"\x1f\x8b":
            import gzip
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", "replace")
    except Exception:
        return ""


def host_of(url):
    try:
        return url.split("/")[2].lower().replace("www.", "")
    except Exception:
        return ""


def discover_sitemaps(host):
    """robots.txt is authoritative when present; conventional paths are the fallback."""
    found = []
    robots = fetch_text("https://%s/robots.txt" % host)
    for line in robots.splitlines():
        if line.lower().startswith("sitemap:"):
            sm = line.split(":", 1)[1].strip()
            if sm.startswith("http"):
                found.append(sm)
    if not found:
        for path in SITEMAP_CANDIDATES:
            for h in ("https://%s%s" % (host, path), "https://www.%s%s" % (host, path)):
                body = fetch_text(h)
                if "<loc>" in body:
                    found.append(h)
                    break
            if found:
                break
    return found[:3]


def harvest_host(host, known, budget):
    """Return (article_urls, sitemaps_used, listed_count) for one host, within budget."""
    urls, used, listed = [], [], 0
    for sm_url in discover_sitemaps(host):
        body = fetch_text(sm_url)
        if not body:
            continue
        used.append(sm_url)
        children = [sm_url] if not IS_INDEX.search(body) else []
        if IS_INDEX.search(body):
            all_children = LOC.findall(body)
            preferred = [c for c in all_children if any(p in c.lower() for p in CHILD_PREFER)]
            pool = preferred or [c for c in all_children
                                 if not any(x in c.lower() for x in CHILD_EXCLUDE)]
            children = pool[:MAX_CHILD_SITEMAPS]
        for child in children:
            child_body = body if child == sm_url else fetch_text(child)
            if not child_body:
                continue
            for loc in LOC.findall(child_body):
                loc = loc.strip()
                if not loc.startswith("http"):
                    continue
                if host_of(loc) != host:
                    continue
                low = loc.lower()
                if low.endswith(URL_EXCLUDE_SUFFIX) or "/feed" in low:
                    continue
                path = loc.split(host, 1)[-1]
                if path in ("", "/", "/#"):
                    continue
                listed += 1
                norm = loc.rstrip("/")
                if norm in known or norm + "/" in known:
                    continue
                known.add(norm)
                urls.append(loc)
                if len(urls) >= min(URLS_PER_HOST, budget):
                    return urls, used, listed
        break  # one working sitemap tree per host is enough
    return urls, used, listed


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"kind": "sitemap-harvest", "ts": ts, "queued": 0, "hosts": 0}

    brief = (rows("p-scout-brief", 5) or [{}])[0]
    deny = set()
    try:
        deny = {h.lower().replace("www.", "") for h in json.loads(brief.get("denyHosts") or "[]")}
    except Exception:
        pass

    # Onboarding requests are consumed once processed; the durable host list lives in sources.
    requests_meta = tokens_meta("p-scout-source-requests", 100)
    requested = []
    for t in requests_meta:
        d = t.get("data") or {}
        h = host_of(d.get("url") or ("https://" + str(d.get("host") or "")))
        if h:
            requested.append(h)

    hosts = list(dict.fromkeys(
        ([host_of("https://" + SITE)] if SITE else [])
        + requested
        + [p.get("host") for p in rows("p-scout-sources") if p.get("host")]
        + [host_of(f.get("url", "")) for pl in ("p-find-brand-new", "p-find-recent", "p-find-archive")
           for f in rows(pl)]))
    hosts = [h for h in hosts if h and h not in deny]

    # Everything the net has ever fetched or queued counts as known.
    known = set()
    for pl in ("p-scout-registry", "p-scout-frontier"):
        for d in rows(pl):
            u = str(d.get("url") or "")
            if u:
                known.add(u.rstrip("/"))

    budget = MAX_TOTAL
    per_host = []
    for h in hosts:
        if budget <= 0:
            break
        urls, used, listed = harvest_host(h, known, budget)
        queued = 0
        for i, u in enumerate(urls):
            try:
                api("POST", "/api/runtime/places/p-scout-frontier/tokens?modelId=" + MODEL,
                    {"name": "sitemap-%s-%d-%s" % (h.replace(".", "-"), i, ts.replace(":", "")),
                     "data": {"url": u, "depth": 0, "attempt": 0, "discoveredFrom": "sitemap",
                              "briefId": brief.get("briefId", ""), "queuedAt": ts}})
                queued += 1
            except Exception:
                continue
        budget -= queued
        per_host.append({"host": h, "sitemaps": used, "listed": listed, "queued": queued})

    # Requests are fulfilled — remove them so a weekly sweep does not re-announce old asks.
    for t in requests_meta:
        try:
            api("DELETE", "/api/runtime/places/p-scout-source-requests/tokens/%s?modelId=%s"
                % (t.get("id"), MODEL))
        except Exception:
            pass

    out.update(queued=sum(p["queued"] for p in per_host), hosts=len(per_host),
               requestsProcessed=len(requests_meta), perHost=per_host)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
