#!/usr/bin/env python3
"""scout-recrawl — keep the investigation WATCHING instead of remembering.

Re-queues the entry pages of every known source host into the frontier so newly published
articles get discovered. Cheap by construction: the fetch lane sends conditional GETs, so an
unchanged page costs a 304 and stops there; a changed index page yields its new links, which
pass through the same dedupe/depth/host gates as any discovered URL — already-filed articles
are dropped, only genuinely new ones enter.

Sources come from the host profiles the taxonomy rollup maintains (p-scout-sources), falling
back to distinct finding hosts if profiles are absent. brief.denyHosts is honoured, hosts are
capped per run, and each gets its root plus the section paths where articles were actually
found (the deepest common directories of its known URLs).
"""
import json, os
import urllib.request
from collections import Counter
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
MAX_HOSTS = 12
MAX_SECTIONS_PER_HOST = 3
BUCKETS = ("p-find-brand-new", "p-find-recent", "p-find-archive")


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
        return ""


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"kind": "recrawl", "ts": ts, "queued": 0, "hosts": 0}

    brief = (rows("p-scout-brief") or [{}])[0]
    deny = set()
    try:
        deny = {h.lower().replace("www.", "") for h in json.loads(brief.get("denyHosts") or "[]")}
    except Exception:
        pass

    profiles = rows("p-scout-sources")
    hosts = [p.get("host") for p in profiles if p.get("host")]
    urls_by_host = {}
    for place in BUCKETS:
        for f in rows(place):
            h = host_of(f.get("url", ""))
            if h:
                urls_by_host.setdefault(h, []).append(f.get("url", ""))
    if not hosts:
        hosts = sorted(urls_by_host.keys())
    hosts = [h for h in hosts if h and h not in deny][:MAX_HOSTS]

    frontier_now = {f.get("url") for f in rows("p-scout-frontier")}
    queued = []
    for h in hosts:
        entries = ["https://%s/" % h]
        # Section paths where this host's articles actually live — better entry points than
        # the root alone (many sites keep the blog off the homepage).
        sections = Counter()
        for u in urls_by_host.get(h, []):
            try:
                parts = u.split("/", 3)
                path = "/" + parts[3] if len(parts) > 3 else "/"
                seg = "/".join(path.split("/")[:2]) + "/"
                if len(seg) > 2:
                    sections[seg] += 1
            except Exception:
                continue
        for seg, n in sections.most_common(MAX_SECTIONS_PER_HOST):
            if n >= 3:
                entries.append("https://%s%s" % (h, seg))
        for idx, u in enumerate(dict.fromkeys(entries)):
            if u in frontier_now:
                continue
            try:
                api("POST", "/api/runtime/places/p-scout-frontier/tokens?modelId=" + MODEL,
                    {"name": "recrawl-%s-%d-%s" % (h.replace(".", "-"), idx, ts.replace(":", "")),
                     "data": {"url": u, "depth": 0, "attempt": 0, "discoveredFrom": "recrawl",
                              "briefId": brief.get("briefId", ""), "queuedAt": ts}})
                queued.append(u)
            except Exception:
                continue
    out.update(queued=len(queued), hosts=len(hosts), urls=queued[:20])
    print(json.dumps(out))


if __name__ == "__main__":
    main()
