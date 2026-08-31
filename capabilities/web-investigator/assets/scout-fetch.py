#!/usr/bin/env python3
"""scout-fetch — fetch ONE url, date it, score it, blob it, discover links.

Runs on the executor via the script-tool runtime (stdin closed, input via args.env).
Stdlib only: the executor host is not guaranteed to have third-party packages.

Prints ONE small JSON object to stdout. Small is load-bearing: executor stdout over
~128KB is auto-offloaded to a blob and REPLACES the whole payload, which would destroy
the routing fields. Full article text goes to the blobstore explicitly; only metadata
and a short extract are printed.
"""
import json, os, re, sys, time, socket, gzip, io
import urllib.request, urllib.error
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, urldefrag

UA = "AgenticNetOS-ResearchScout/1.0 (+local)"
MAX_BYTES = 2_000_000
TIMEOUT = 20
MAX_LINKS = 25
EXTRACT_CHARS = 600

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
BLOBS = os.environ.get("BLOB_URL", "http://127.0.0.1:8090").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")

# Transient classes get requeued; permanent ones never do.
TRANSIENT = {"timeout", "dns", "http-429", "http-5xx", "tls"}
MAX_ATTEMPT = 3


def api(method, path, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def registry_lookup(url):
    """Newest etag/last-modified for this url, plus its tokenId so we can replace it.

    The engine has no upsert-by-key, so the ledger is kept at one token per URL by
    deleting the previous entry before writing a new one. Newest-first ordering matters:
    a stale duplicate would hand back an expired etag and defeat the conditional GET.
    """
    try:
        q = {"arcql": 'FROM $ WHERE $.url == "%s" ORDER BY $.seenAt DESC LIMIT 1'
             % url.replace('"', '\\"'), "limit": 1}
        res = api("POST", "/api/runtime/places/p-scout-registry/tokens/query?modelId=" + MODEL, q)
        for t in (res.get("tokens") or []):
            d = t.get("data") or {}
            tid = t.get("id") or (t.get("_meta") or {}).get("id") or ""
            return d.get("etag") or "", d.get("lastModified") or "", tid
    except Exception:
        pass
    return "", "", ""


def registry_upsert(url, etag, last_mod, outcome, prev_id=""):
    """Replace the ledger entry (delete-then-insert), since there is no upsert."""
    try:
        if prev_id:
            try:
                api("DELETE", "/api/runtime/places/p-scout-registry/tokens/%s?modelId=%s"
                    % (prev_id, MODEL))
            except Exception:
                pass
        api("POST", "/api/runtime/places/p-scout-registry/tokens?modelId=" + MODEL,
            {"data": {"url": url, "etag": etag or "", "lastModified": last_mod or "",
                      "lastOutcome": outcome, "seenAt": now_iso()}})
    except Exception:
        pass


def put_blob(text):
    req = urllib.request.Request(BLOBS + "/api/blobs", data=text.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "text/plain; charset=utf-8")  # omit and the body is mangled
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Extract(HTMLParser):
    """Minimal stdlib extractor: title, visible text, links, date meta."""
    SKIP = {"script", "style", "noscript", "template", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.in_title = "", False
        self.stack, self.text, self.links = [], [], []
        self.meta = {}
        self.ld = []
        self.in_ld = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.stack.append(tag)
        if tag == "title":
            self.in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content"):
                self.meta[key] = a["content"]
        elif tag == "time" and a.get("datetime"):
            self.meta.setdefault("__time", a["datetime"])
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "script" and (a.get("type") or "").lower() == "application/ld+json":
            self.in_ld = True

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "script":
            self.in_ld = False
        if self.stack and tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif self.in_ld:
            self.ld.append(data)
        elif not (set(self.stack) & self.SKIP):
            s = data.strip()
            if s:
                self.text.append(s)


ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


def parse_date(s):
    if not s:
        return None
    m = ISO.search(s)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
    except ValueError:
        return None


def find_date(ex, headers):
    """Return (datetime, source). Source is the field the health rollup optimises against."""
    for k in ("article:published_time", "og:published_time", "datepublished",
              "article:modified_time", "date", "dc.date", "pubdate"):
        d = parse_date(ex.meta.get(k))
        if d:
            return d, ("og" if k.startswith(("article:", "og:")) else "meta")
    for blob in ex.ld:
        try:
            obj = json.loads(blob)
        except Exception:
            continue
        for node in (obj if isinstance(obj, list) else [obj]):
            if isinstance(node, dict):
                d = parse_date(node.get("datePublished") or node.get("dateCreated"))
                if d:
                    return d, "json-ld"
    d = parse_date(ex.meta.get("__time"))
    if d:
        return d, "time-tag"
    d = parse_date(headers.get("Last-Modified", ""))
    if d:
        return d, "header"
    return None, "none"


def score_text(title, text, brief):
    inc = [t.lower() for t in (brief.get("mustInclude") or []) if t.strip()]
    exc = [t.lower() for t in (brief.get("mustExclude") or []) if t.strip()]
    hay, head = text.lower(), title.lower()
    for t in exc:
        if t in hay or t in head:
            return 0
    if not inc:
        return 50
    got = 0
    for t in inc:
        if t in head:
            got += 3
        got += min(hay.count(t), 5)
    return int(min(100, (got / (len(inc) * 5.0)) * 100))


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()




def spool_links(links, parent_url, parent_depth, brief):
    """Queue newly discovered URLs into the frontier, deduped. Runs INLINE here rather
    than in a downstream lane because a JSON string cannot survive a map template into
    args.env: the engine auto-parses JSON-looking strings and type preservation re-emits
    an array, which the executor drops. Doing it here also saves an executor round trip.
    Returns counters that ride out on the result token and into telemetry."""
    c = {"spoolQueued": 0, "spoolKnown": 0, "spoolFiltered": 0,
         "spoolDepthStopped": 0, "spoolMalformed": 0, "frontierCandidates": [],
           "pageType": "article", "gateVerdict": "low-score"}
    child = parent_depth + 1
    # Depth capped with < (never !=): != also matches missing and overshoot.
    if child >= int(brief.get("maxDepth") or 3):
        c["spoolDepthStopped"] = len(links)
        return c

    def urls_in(place):
        try:
            res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                      {"arcql": "FROM $ LIMIT 3000", "limit": 3000})
            return {(t.get("data") or {}).get("url") for t in (res.get("tokens") or [])
                    if (t.get("data") or {}).get("url")}
        except Exception:
            return set()

    deny = {h.lower() for h in (brief.get("denyHosts") or [])}
    allow = {h.lower() for h in (brief.get("allowHosts") or [])}
    same_host = bool(brief.get("sameHostOnly"))
    phost = urlparse(parent_url).netloc.lower()
    known = urls_in("p-scout-registry") | urls_in("p-scout-frontier")
    frontier_n = len(urls_in("p-scout-frontier"))

    fresh = []
    for u in links:
        # Untrusted web content enters the queue here and nowhere else.
        if len(u) > 2048 or any(ch in u for ch in '"\\<>{}|^`') or any(ord(ch) < 0x20 for ch in u):
            c["spoolMalformed"] += 1
            continue
        h = urlparse(u).netloc.lower()
        if h in deny or (allow and h not in allow) or (same_host and phost and h != phost):
            c["spoolFiltered"] += 1
            continue
        if u in known:
            c["spoolKnown"] += 1
            continue
        if frontier_n + len(fresh) >= 2000:
            continue
        fresh.append(u)

    if fresh:
        # The NET queues these, not this script: the lift lane emits them with fanOut:true,
        # one token per element, so link discovery is a visible arc on the canvas instead of
        # a hidden POST. We still CLAIM them in the registry here, because dedupe must happen
        # at queue time — a URL is invisible between leaving the frontier and its post-fetch
        # registry write, and concurrent fetches re-queue popular nav pages repeatedly
        # (measured: 118 fetches for 57 URLs, one page 6x).
        c["frontierCandidates"] = [
            {"url": u, "depth": child, "attempt": 0, "discoveredFrom": parent_url,
             "briefId": brief.get("briefId", ""), "queuedAt": now_iso()} for u in fresh]
        c["spoolQueued"] = len(fresh)
        try:
            api("POST", "/api/runtime/places/p-scout-registry/tokens/bulk?modelId=" + MODEL,
                {"tokens": [{"data": {"url": u, "etag": "", "lastModified": "",
                                      "lastOutcome": "queued", "seenAt": now_iso()}}
                            for u in fresh]})
        except Exception:
            pass
    return c




def classify_page(url):
    """index vs article. A listing page (site root, /category/, /tag/, /blog/, /page/2/)
    has no publication date and is not a competitor ARTICLE — but it is still worth
    fetching for its links. Categorising one costs a model call and files a fake finding:
    measured 34 of 156 findings were listing pages, and one competitor's entire presence
    turned out to be index pages with no articles behind them."""
    p = urlparse(url)
    path = p.path or "/"
    if path in ("", "/") or p.query:
        return "index"
    seg = [x for x in path.split("/") if x]
    if not seg:
        return "index"
    if seg[0].lower() in ("category", "tag", "author", "blog", "topics", "archives", "search"):
        return "index"
    if len(seg) >= 2 and seg[-2].lower() == "page" and seg[-1].isdigit():
        return "index"
    return "article"


def _normalise_brief(b):
    """Node stores token properties as STRINGS, so a list arrives as JSON text whether the
    brief came from its place or through BRIEF_JSON in the env. Both paths must run this:
    skipping it leaves mustExclude as a string, score_text then iterates its CHARACTERS, and
    the first character present in any page forces an instant score of 0."""
    if not isinstance(b, dict):
        return {}
    for k in ("mustInclude", "mustExclude", "denyHosts", "allowHosts"):
        v = b.get(k)
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                b[k] = parsed if isinstance(parsed, list) else [str(parsed)]
            except Exception:
                b[k] = [x.strip() for x in v.split(",") if x.strip()]
    return b


def load_brief():
    """Read the active brief from its place. Passing it through a map template would mean
    embedding JSON inside JSON — one quote in a term and the CommandToken is malformed.
    BRIEF_JSON in the env still wins when set, so a lane can override for testing."""
    raw = os.environ.get("BRIEF_JSON")
    if raw:
        try:
            return _normalise_brief(json.loads(raw))
        except Exception:
            pass
    try:
        res = api("POST", "/api/runtime/places/p-scout-brief/tokens/query?modelId=" + MODEL,
                  {"arcql": "FROM $ LIMIT 5", "limit": 5})
        best = None
        for t in (res.get("tokens") or []):
            d = t.get("data") or {}
            if str(d.get("active", "true")).lower() != "false":
                best = d
        if best:
            return _normalise_brief(best)
    except Exception:
        pass
    return {}


def main():
    url = (os.environ.get("URL") or "").strip()
    depth = int(os.environ.get("DEPTH") or 0)
    attempt = int(os.environ.get("ATTEMPT") or 0)
    brief = load_brief()

    out = {"url": url, "host": urlparse(url).netloc, "depth": depth, "attempt": attempt,
           "briefId": brief.get("briefId", ""), "ts": now_iso(), "outcome": "error",
           "failureClass": "none", "httpStatus": 0, "durationMs": 0, "bytes": 0,
           "title": "", "publishedAt": "", "ageDays": -1, "recency": "archive",
           "dateSource": "none", "score": 0, "extract": "", "blobUrn": "",
           "extractChars": 0, "linksFound": 0, "discoveredUrls": [],
           # Pre-serialised because args.env values must be STRINGS: a template can only
           # preserve the array type, and the executor drops a non-string env value.
           "discoveredJson": "[]", "retry": "no",
           "spoolQueued": 0, "spoolKnown": 0, "spoolFiltered": 0,
           "spoolDepthStopped": 0, "spoolMalformed": 0, "frontierCandidates": [],
           "pageType": "article", "gateVerdict": "low-score"}

    if not url:
        out["failureClass"] = "no-url"
        emit(out); return

    etag, last_mod, prev_id = registry_lookup(url)
    started = time.time()
    fail = None
    try:
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", UA)
        req.add_header("Accept-Encoding", "gzip")
        if etag:
            req.add_header("If-None-Match", etag)
        if last_mod:
            req.add_header("If-Modified-Since", last_mod)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            status, headers = r.status, dict(r.headers)
            raw = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        status, headers, raw = e.code, dict(e.headers or {}), b""
        if status == 304:
            fail = None
        elif status == 429:
            fail = "http-429"
        elif status == 403:
            fail = "http-403-paywall"
        elif 400 <= status < 500:
            fail = "http-4xx"
        else:
            fail = "http-5xx"
    except urllib.error.URLError as e:
        status, headers, raw = 0, {}, b""
        reason = str(getattr(e, "reason", e)).lower()
        fail = ("timeout" if "timed out" in reason
                else "dns" if "name or service" in reason or "nodename" in reason
                else "tls" if "ssl" in reason or "certificate" in reason
                else "dns")
    except socket.timeout:
        status, headers, raw, fail = 0, {}, b"", "timeout"
    except Exception:
        status, headers, raw, fail = 0, {}, b"", "dns"

    out["durationMs"] = int((time.time() - started) * 1000)
    out["httpStatus"] = status

    if status == 304:
        out.update(outcome="not-modified", failureClass="ok")
        registry_upsert(url, etag, last_mod, "not-modified", prev_id)
        emit(out); return

    if fail:
        out.update(outcome="failed", failureClass=fail)
        if fail in TRANSIENT and attempt + 1 < MAX_ATTEMPT:
            out.update(retry="yes", attempt=attempt + 1)
        registry_upsert(url, etag, last_mod, fail, prev_id)
        emit(out); return

    if headers.get("Content-Encoding", "").lower() == "gzip":
        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass
    out["bytes"] = len(raw)
    if len(raw) > MAX_BYTES:
        out.update(outcome="failed", failureClass="size-capped")
        registry_upsert(url, headers.get("ETag", ""), headers.get("Last-Modified", ""), "size-capped", prev_id)
        emit(out); return

    ctype = (headers.get("Content-Type") or "").lower()
    if "html" not in ctype and "xml" not in ctype and ctype:
        out.update(outcome="failed", failureClass="non-html")
        registry_upsert(url, headers.get("ETag", ""), headers.get("Last-Modified", ""), "non-html", prev_id)
        emit(out); return

    ex = Extract()
    try:
        ex.feed(raw.decode("utf-8", "replace"))
    except Exception:
        pass
    text = " ".join(ex.text)
    title = " ".join(ex.title.split())[:300]

    if len(text) < 200:
        # Almost always a JS-rendered page. Recorded, not retried.
        out.update(outcome="failed", failureClass="empty-extract", title=title,
                   extractChars=len(text))
        registry_upsert(url, headers.get("ETag", ""), headers.get("Last-Modified", ""), "empty-extract", prev_id)
        emit(out); return

    dt, src = find_date(ex, headers)
    brand = int(brief.get("brandNewDays") or 7)
    recent = int(brief.get("recentDays") or 90)
    if dt:
        age = max(0, (datetime.now(timezone.utc) - dt).days)
        recency = "brand-new" if age <= brand else ("recent" if age <= recent else "archive")
        out["publishedAt"] = dt.strftime("%Y-%m-%d")
    else:
        # Undated defaults to archive: never claim novelty we cannot prove.
        # dateSource="none" is what the health rollup counts.
        age, recency = -1, "archive"

    links, seen = [], set()
    base_host = urlparse(url).netloc
    for h in ex.links:
        try:
            absu = urldefrag(urljoin(url, h))[0]
        except Exception:
            continue
        p = urlparse(absu)
        if p.scheme not in ("http", "https") or absu in seen:
            continue
        seen.add(absu)
        links.append(absu)
        if len(links) >= MAX_LINKS:
            break

    blob_urn = ""
    try:
        blob_urn = put_blob("URL: %s\nTITLE: %s\nPUBLISHED: %s\n\n%s"
                            % (url, title, out["publishedAt"], text))["urn"]
    except Exception:
        pass

    out.update(spool_links(links, url, depth, brief))
    page_type = classify_page(url)
    score_val = score_text(title, text, brief)
    try:
        min_score = int(brief.get("minScore") or 0)
    except Exception:
        min_score = 0
    # Collapsed to ONE literal the gate lane can route on.
    verdict = ("index" if page_type == "index"
               else "pass" if score_val >= min_score else "low-score")
    out.update(pageType=page_type, gateVerdict=verdict)
    out.update(outcome="ok", failureClass="ok", title=title, ageDays=age, recency=recency,
               dateSource=src, score=score_val,
               extract=text[:EXTRACT_CHARS], blobUrn=blob_urn, extractChars=len(text),
               linksFound=len(links), discoveredUrls=links,
               discoveredJson=json.dumps(links))
    registry_upsert(url, headers.get("ETag", ""), headers.get("Last-Modified", ""), "ok", prev_id)
    emit(out)


if __name__ == "__main__":
    main()
