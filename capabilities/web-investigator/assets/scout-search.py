#!/usr/bin/env python3
"""scout-search — widen the crawl by asking a search engine, not just following links.

Link-following only reaches what the seeds already point at, so the corpus inherits the
seeds' blind spots. This queries a search API and feeds fresh hosts into the same frontier,
through the same dedupe and host filters as every other URL.

Provider-agnostic on purpose: a pack should not force one vendor. Whichever key is present
wins, so the pack ships usable and the operator brings their own account.

Key arrives as $SEARCH_API_KEY (set_transition_credentials -> executor env). It is NEVER in
a token: places are event-sourced, so a pasted key would be permanent.
"""
import json, os, urllib.request, urllib.parse
from datetime import datetime, timezone
from urllib.parse import urlparse

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
KEY = os.environ.get("SEARCH_API_KEY", "").strip()
PROVIDER = (os.environ.get("SEARCH_PROVIDER") or "brave").strip().lower()
MAX_RESULTS = int(os.environ.get("MAX_RESULTS") or 20)


def api(method, path, body=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_brief():
    try:
        res = api("POST", "/api/runtime/places/p-scout-brief/tokens/query?modelId=" + MODEL,
                  {"arcql": "FROM $ LIMIT 5", "limit": 5})
        best = None
        for t in (res.get("tokens") or []):
            d = t.get("data") or {}
            if str(d.get("active", "true")).lower() != "false":
                best = d
        if not best:
            return {}
        for k in ("mustInclude", "mustExclude", "denyHosts", "allowHosts"):
            v = best.get(k)
            if isinstance(v, str):
                try:
                    best[k] = json.loads(v)
                except Exception:
                    best[k] = [x.strip() for x in v.split(",") if x.strip()]
        return best
    except Exception:
        return {}


def search(query):
    """Returns (urls, providerUsed). Each provider is one request; failures raise."""
    if PROVIDER == "brave":
        url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(
            {"q": query, "count": min(MAX_RESULTS, 20)})
        req = urllib.request.Request(url)
        req.add_header("X-Subscription-Token", KEY)
        req.add_header("Accept", "application/json")
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode())
        return [x.get("url") for x in (d.get("web", {}).get("results") or []) if x.get("url")], "brave"

    if PROVIDER == "tavily":
        req = urllib.request.Request("https://api.tavily.com/search",
                                     data=json.dumps({"api_key": KEY, "query": query,
                                                      "max_results": MAX_RESULTS}).encode(),
                                     method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode())
        return [x.get("url") for x in (d.get("results") or []) if x.get("url")], "tavily"

    if PROVIDER == "serper":
        req = urllib.request.Request("https://google.serper.dev/search",
                                     data=json.dumps({"q": query, "num": MAX_RESULTS}).encode(),
                                     method="POST")
        req.add_header("X-API-KEY", KEY)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode())
        return [x.get("link") for x in (d.get("organic") or []) if x.get("link")], "serper"

    raise ValueError("unknown SEARCH_PROVIDER '%s' (brave|tavily|serper)" % PROVIDER)


def urls_in(place):
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                  {"arcql": "FROM $ LIMIT 3000", "limit": 3000})
        return {(t.get("data") or {}).get("url") for t in (res.get("tokens") or [])
                if (t.get("data") or {}).get("url")}
    except Exception:
        return set()


def main():
    query = (os.environ.get("QUERY") or "").strip()
    out = {"query": query, "provider": PROVIDER, "found": 0, "queued": 0, "known": 0,
           "hostFiltered": 0, "malformed": 0, "frontierCandidates": [], "ts": now_iso(),
           "outcome": "ok", "error": ""}
    if not query:
        out.update(outcome="failed", error="no QUERY")
        print(json.dumps(out)); return
    if not KEY:
        # Explicit, not silent: a search lane with no credential looks identical to a
        # search that found nothing, and that ambiguity wastes an afternoon.
        out.update(outcome="failed", error="SEARCH_API_KEY not set — "
                   "set_transition_credentials {transitionId:'t-scout-search', "
                   "credentials:{SEARCH_API_KEY:'...'}}")
        print(json.dumps(out)); return

    brief = load_brief()
    try:
        urls, used = search(query)
        out["provider"] = used
    except Exception as e:
        out.update(outcome="failed", error=("%s: %s" % (type(e).__name__, str(e)))[:200])
        print(json.dumps(out)); return

    out["found"] = len(urls)
    deny = {h.lower() for h in (brief.get("denyHosts") or [])}
    allow = {h.lower() for h in (brief.get("allowHosts") or [])}
    known = urls_in("p-scout-registry") | urls_in("p-scout-frontier")

    fresh, seen = [], set()
    for u in urls:
        if not isinstance(u, str) or not u.startswith(("http://", "https://")) or u in seen:
            continue
        seen.add(u)
        # Same guard as link discovery: a URL reaches a JSON map template downstream.
        if len(u) > 2048 or any(c in u for c in '"\\<>{}|^`') or any(ord(c) < 0x20 for c in u):
            out["malformed"] += 1
            continue
        host = urlparse(u).netloc.lower()
        if host in deny or (allow and host not in allow):
            out["hostFiltered"] += 1
            continue
        if u in known:
            out["known"] += 1
            continue
        fresh.append(u)

    if fresh:
        # Search hits enter at depth 0: they are seeds in their own right, so link-following
        # gets its full depth budget from each one rather than starting already spent.
        out["frontierCandidates"] = [
            {"url": u, "depth": 0, "attempt": 0, "discoveredFrom": "search:" + query,
             "briefId": brief.get("briefId", ""), "queuedAt": now_iso()} for u in fresh]
        out["queued"] = len(fresh)
        try:
            api("POST", "/api/runtime/places/p-scout-registry/tokens/bulk?modelId=" + MODEL,
                {"tokens": [{"data": {"url": u, "etag": "", "lastModified": "",
                                      "lastOutcome": "queued", "seenAt": now_iso()}}
                            for u in fresh]})
        except Exception:
            pass
    print(json.dumps(out))


if __name__ == "__main__":
    main()
