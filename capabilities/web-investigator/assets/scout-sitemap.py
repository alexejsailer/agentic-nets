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

# >>> shared: scoutlib (generated, do not edit here)
# scoutlib: helpers shared by every scout script. CANONICAL SOURCE. The executor materialises
# each registered script alone from a content-addressed blob, so a sibling module cannot be
# imported at run time: tools/inline-shared.py copies this file verbatim into every script
# between the shared markers, and tests/test_shared_sync.py fails when a copy drifts.
# Stdlib only, Python 3.9 compatible.
import json, os, re, sys, socket, zlib, ipaddress, email.utils
import urllib.request, urllib.error
from datetime import datetime, timezone
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
BLOBS = os.environ.get("BLOB_URL", "http://127.0.0.1:8090").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
# Internal service auth: the executor exports AGENTICOS_SERVICE_TOKEN; when the backends require
# it (X-Service-Auth) it is attached to master/blobstore calls ONLY. External requests never get it.
SERVICE_TOKEN = os.environ.get("AGENTICOS_SERVICE_TOKEN", "").strip()
# Every swallowed backend failure is recorded here and rides out on the result token as
# `libErrors`, so a 401, a 404 or a timeout is never mistaken for "no data".
LIB_ERRORS = []


class MasterError(Exception):
    def __init__(self, status, body):
        super().__init__("master %s: %s" % (status, body))
        self.status, self.body = status, body


def _record(kind, detail):
    LIB_ERRORS.append("%s: %s" % (kind, str(detail)[:160]))


def api(method, path, body=None, timeout=25):
    """Master call. Raises MasterError (status, body) instead of a bare urllib error."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if SERVICE_TOKEN:
        req.add_header("X-Service-Auth", "Bearer " + SERVICE_TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise MasterError(e.code, e.read().decode("utf-8", "replace")[:300])
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        raise MasterError(0, str(getattr(e, "reason", e)))
    return json.loads(raw) if raw.strip() else {}


def tokens_with_meta(place, limit=2000, where=None, critical=False):
    """Tokens (with ids) of a place. `where` is an ArcQL predicate (AND/OR, ==, !=; no IN).
    On failure the error is recorded; with critical=True it is raised instead."""
    arcql = "FROM $ WHERE %s LIMIT %d" % (where, limit) if where else "FROM $ LIMIT %d" % limit
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                  {"arcql": arcql, "limit": limit})
        return res.get("tokens") or []
    except MasterError as e:
        _record("read " + place, "%s %s" % (e.status, e.body))
        if critical:
            raise
        return []


def rows(place, limit=2000, where=None, critical=False):
    return [(t.get("data") or {}) for t in tokens_with_meta(place, limit, where, critical)]


def token_id(t):
    return t.get("id") or (t.get("_meta") or {}).get("id") or ""


def env_int(key, default=0):
    # Template interpolation renders a MISSING field as the string 'null'; never crash on it.
    try:
        return int(os.environ.get(key) or default)
    except (TypeError, ValueError):
        return default


def env_str(key, default=""):
    v = (os.environ.get(key) or "").strip()
    return default if v.lower() in ("", "null", "none", "undefined") else v


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def host_of(url, default=""):
    try:
        h = (url or "").split("/")[2].lower()
        if h.startswith("www."):
            h = h[4:]
        return h or default
    except Exception:
        return default


TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid",
                   "ref", "ref_src", "_ga", "yclid")


def canonical_url(u):
    """One key per page: lowercase scheme and host, no default port, no leading www., no fragment,
    tracking parameters dropped and the rest sorted, at most one trailing slash (none except root)."""
    try:
        p = urlparse((u or "").strip())
    except Exception:
        return (u or "").strip()
    if not p.scheme or not p.netloc:
        return (u or "").strip()
    host = p.hostname or ""
    if host.startswith("www."):
        host = host[4:]
    port = p.port
    if port and not ((p.scheme == "http" and port == 80) or (p.scheme == "https" and port == 443)):
        host = "%s:%d" % (host, port)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
         if not any(k.lower() == t or (t.endswith("_") and k.lower().startswith(t)) for t in TRACKING_PARAMS)]
    q.sort()
    path = re.sub(r"/{2,}", "/", p.path or "/")
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/") or "/"
    return urlunparse((p.scheme.lower(), host, path, "", urlencode(q), ""))


def safe_url(u, resolve=True):
    """(ok, reason). Only http(s), no credentials, standard ports, and no resolved address that is
    private, loopback, link-local, reserved, multicast or unspecified. Discovered links come from
    untrusted pages; without this gate a crawled page can point the executor at the metadata service
    or at our own backends."""
    try:
        p = urlparse(u)
    except Exception:
        return False, "unparseable"
    if p.scheme not in ("http", "https"):
        return False, "scheme"
    if not p.hostname:
        return False, "no-host"
    if p.username or p.password:
        return False, "credentials"
    if p.port not in (None, 80, 443):
        return False, "port"
    host = p.hostname
    if host in ("localhost",) or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".internal"):
        return False, "internal-name"
    try:
        ip = ipaddress.ip_address(host)
        addrs = [ip]
    except ValueError:
        if not resolve:
            return True, "unresolved"
        try:
            addrs = [ipaddress.ip_address(ai[4][0]) for ai in socket.getaddrinfo(host, None)]
        except (socket.gaierror, OSError, ValueError):
            return False, "dns"
    for ip in addrs:
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return False, "blocked-address"
    return True, "ok"


class BlockedRedirect(urllib.error.URLError):
    pass


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-runs safe_url on every redirect target and remembers the final url."""
    def __init__(self):
        super().__init__()
        self.final_url = None
        self.hops = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        ok, why = safe_url(newurl)
        if not ok:
            raise BlockedRedirect("blocked-address: redirect to %s (%s)" % (newurl, why))
        self.hops += 1
        self.final_url = newurl
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def safe_opener():
    h = SafeRedirectHandler()
    return urllib.request.build_opener(h), h


class SizeCapped(Exception):
    pass


class CorruptEncoding(Exception):
    pass


def read_bounded(resp, max_bytes):
    return resp.read(max_bytes + 1)


def gunzip_bounded(raw, max_bytes):
    """Streaming gunzip that stops as soon as the OUTPUT exceeds max_bytes (a 2 MB bomb cannot
    become 2 GB in RAM). Raises SizeCapped or CorruptEncoding."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = bytearray()
    try:
        for i in range(0, len(raw), 65536):
            out += d.decompress(raw[i:i + 65536], max_bytes + 1 - len(out))
            if len(out) > max_bytes:
                raise SizeCapped()
            while d.unconsumed_tail:
                out += d.decompress(d.unconsumed_tail, max_bytes + 1 - len(out))
                if len(out) > max_bytes:
                    raise SizeCapped()
        out += d.flush()
    except zlib.error as e:
        raise CorruptEncoding(str(e))
    if len(out) > max_bytes:
        raise SizeCapped()
    return bytes(out)


_CHARSET_HDR = re.compile(r"charset\s*=\s*[\"']?([A-Za-z0-9_.:-]+)", re.I)
_CHARSET_META = re.compile(rb"<meta[^>]+charset\s*=\s*[\"']?\s*([A-Za-z0-9_.:-]+)", re.I)


def decode_body(raw, content_type="", sniff_html=True):
    """(text, codec, replacementRatio). Header charset, else <meta charset>, then strict utf-8,
    then cp1252, then utf-8 with replacement. Pages that are not UTF-8 used to become
    replacement-character soup that was scored, dated and stored as if valid."""
    cands = []
    m = _CHARSET_HDR.search(content_type or "")
    if m:
        cands.append(m.group(1))
    if sniff_html:
        m = _CHARSET_META.search(raw[:2048])
        if m:
            cands.append(m.group(1).decode("ascii", "ignore"))
    cands += ["utf-8", "cp1252"]
    seen = set()
    for c in cands:
        c = c.lower().replace("iso-8859-1", "cp1252").replace("latin-1", "cp1252")
        if c in seen:
            continue
        seen.add(c)
        try:
            return raw.decode(c, "strict"), c, 0.0
        except (LookupError, UnicodeDecodeError):
            continue
    text = raw.decode("utf-8", "replace")
    ratio = text.count("�") / (len(text) or 1)
    return text, "utf-8-replace", round(ratio, 4)


def put_blob(text, timeout=30):
    req = urllib.request.Request(BLOBS + "/api/blobs", data=text.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "text/plain; charset=utf-8")  # omit and the body is mangled
    if SERVICE_TOKEN:
        req.add_header("X-Service-Auth", "Bearer " + SERVICE_TOKEN)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def blob_text(urn, timeout=25):
    """Stored article text by URN (reads are open). The fetch script prefixes a
    'URL/TITLE/PUBLISHED' header before a blank line; strip it so the model sees prose."""
    if not urn or "blob:" not in urn:
        return ""
    try:
        with urllib.request.urlopen(BLOBS + "/api/blobs/" + urn.split("blob:", 1)[1], timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except Exception as e:
        _record("blob read", "%s %s" % (urn[-24:], e))
        return ""
    body = raw.split("\n\n", 1)[1] if "\n\n" in raw[:400] else raw
    return " ".join(body.split())


# Prose detection in two tiers: a capital-letter start skips lowercase navigation chrome (the
# case the original heuristic was built for); when nothing matches, any letter may start a
# sentence, so lowercase-styled and non-Latin pages still yield a body instead of nothing.
SENTENCE_CAP = re.compile(r"[A-Z\u00c0-\u00d6\u00d8-\u00de][^.!?]{40,}?[.!?](?:\s|$)")
SENTENCE = re.compile(r"[^\s.!?][^.!?]{40,}?[.!?](?:\s|$)")


def article_body(text, title):
    """Drop site chrome: prose starts at the first real sentence at or after the last echo of
    the title (the H1 sits directly above its own text), when that echo is in the first 60%."""
    start = 0
    key = " ".join((title or "").split()[:6])
    if key and len(key) > 12:
        i = text.rfind(key)
        if 0 <= i < len(text) * 0.6:
            start = i
    m = (SENTENCE_CAP.search(text, start) or SENTENCE_CAP.search(text)
         or SENTENCE.search(text, start) or SENTENCE.search(text))
    return text[m.start():] if m else text


def key_points(v):
    """keyPoints arrive as a JSON string (node stores properties as strings) or a list."""
    if isinstance(v, list):
        return [str(x)[:160] for x in v][:5]
    try:
        parsed = json.loads(v or "[]")
        return [str(x)[:160] for x in parsed][:5] if isinstance(parsed, list) else [str(parsed)[:160]]
    except Exception:
        return [x.strip()[:160] for x in str(v or "").split(";") if x.strip()][:5]


def as_list(v):
    """A brief list field arrives as a JSON string, a comma list or a list."""
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if v is None:
        return []
    s = str(v).strip()
    if not s:
        return []
    try:
        parsed = json.loads(s)
        if isinstance(parsed, list):
            return [str(x).strip() for x in parsed if str(x).strip()]
        return [str(parsed).strip()]
    except Exception:
        return [x.strip() for x in s.split(",") if x.strip()]


def normalise_brief(b):
    """Node stores token properties as STRINGS: every list field is normalised here, and every
    script uses this one path (a comma list that one reader parsed as JSON and another did not
    let the owner's own host into the findings corpus)."""
    if not isinstance(b, dict):
        return {}
    for k in ("mustInclude", "mustExclude", "denyHosts", "allowHosts", "categories"):
        if k in b and not isinstance(b.get(k), list):
            b[k] = as_list(b.get(k))
    return b


def brief_is_active(d):
    return str(d.get("active", "true")).strip().lower() != "false"


def load_brief(limit=5, allow_env=True):
    """The newest ACTIVE brief (active != "false"). BRIEF_JSON in the env wins when set, so a
    lane can hand the brief in directly; a malformed BRIEF_JSON is recorded, not ignored."""
    raw = os.environ.get("BRIEF_JSON") if allow_env else None
    if raw:
        try:
            return normalise_brief(json.loads(raw))
        except Exception as e:
            _record("BRIEF_JSON", "malformed: %s" % e)
    best = None
    for d in rows("p-scout-brief", limit):
        if brief_is_active(d):
            best = d
    return normalise_brief(best) if best else {}


def load_policies():
    """(newest policy per host, error). Missing place or empty log = everything allowed, but a
    read failure is returned so the caller can say `policyLoadFailed` instead of silently allowing."""
    pol, err = {}, None
    try:
        res = api("POST", "/api/runtime/places/p-scout-source-policy/tokens/query?modelId=" + MODEL,
                  {"arcql": "FROM $ LIMIT 500", "limit": 500})
        rs = sorted(((t.get("data") or {}) for t in (res.get("tokens") or [])),
                    key=lambda d: str(d.get("setAt") or d.get("_emittedAt") or ""))
        for d in rs:
            h = str(d.get("host") or "").lower().replace("www.", "").strip("/ ")
            if h and d.get("policy") in ("allow", "index-only", "ignore"):
                pol[h] = d["policy"]
    except MasterError as e:
        err = "%s %s" % (e.status, e.body)
        _record("policies", err)
    return pol, err


def policy_for(url, policies):
    return (policies or {}).get(host_of(url), "allow")


# Provenance host rules (one table for fetch and taxonomy so a backfill agrees with a fresh fetch).
SOURCE_HOSTS = [
    (("reddit.com", "redd.it", "stackexchange.com", "stackoverflow.com", "quora.com"), "forum"),
    (("twitter.com", "x.com", "facebook.com", "instagram.com", "linkedin.com",
      "tiktok.com", "pinterest.com", "mastodon.", "bsky.app", "threads.net"), "social"),
    (("youtube.com", "youtu.be", "vimeo.com", "rumble.com"), "video"),
    (("amazon.", "ebay.", "walmart.", "homedepot.", "lowes.", "etsy.", "aliexpress."), "commercial"),
    (("wikipedia.org", "wikihow.com"), "docs"),
    (("medium.com", "substack.com", "blogspot.", "wordpress.com", "tumblr.com"), "blog"),
]

# Anchored to the START of a value: "2025-07-03T10:00:00Z" parses, "build-v2023-01-01-final" does not.
ISO = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})(?!\d)")


def parse_date(s):
    if not s:
        return None
    m = ISO.search(str(s))
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_http_date(s):
    """RFC 1123 (Last-Modified) which never contains an ISO date."""
    if not s:
        return None
    try:
        return email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError):
        return None


def finish(out):
    """Print the ONE result object. Backend failures recorded during the run ride out as
    `libErrors` so the next lane can tell 'no data' from 'could not read'."""
    if LIB_ERRORS and isinstance(out, dict):
        out["libErrors"] = list(LIB_ERRORS)[:20]
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()


def main_guard(fn, contract):
    """Run fn(); on any crash still print the script's contract with outcome failed, then exit 1.
    Before, a crash printed nothing and the lane had no token to route."""
    try:
        fn()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001
        out = dict(contract)
        out.update(outcome="failed", failureClass="crash", error=repr(e)[:200])
        finish(out)
        sys.exit(1)
# <<< shared: scoutlib


SITE = (os.environ.get("SITE") or "").strip()          # optional: harvest ONE site only


URLS_PER_HOST = env_int("URLS_PER_HOST", 150)
MAX_TOTAL = env_int("MAX_TOTAL", 300)
MAX_CHILD_SITEMAPS = 10
TIMEOUT = 25
UA = "agenticos-scout-sitemap/1.0"

MAX_XML_BYTES = 5_000_000
FETCH_STATUS = {}   # url -> ok | http-<code> | blocked | failed | size-capped


def fetch_text(url):
    """Bounded, address-checked text fetch; "" on any failure, with the reason in FETCH_STATUS so a
    host's perHost entry can say no-sitemap versus fetch-failed instead of "" for both."""
    ok, why = safe_url(url)
    if not ok:
        FETCH_STATUS[url] = "blocked"; return ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
        opener, _ = safe_opener()
        with opener.open(req, timeout=TIMEOUT) as r:
            raw = read_bounded(r, MAX_XML_BYTES)
            enc = (r.headers.get("Content-Encoding") or "").lower()
        if enc == "gzip" or raw[:2] == b"\x1f\x8b":
            raw = gunzip_bounded(raw, MAX_XML_BYTES)
        if len(raw) > MAX_XML_BYTES:
            FETCH_STATUS[url] = "size-capped"; return ""
        FETCH_STATUS[url] = "ok"
        return raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        FETCH_STATUS[url] = "http-%s" % e.code; return ""
    except SizeCapped:
        FETCH_STATUS[url] = "size-capped"; return ""
    except Exception as e:  # noqa: BLE001
        FETCH_STATUS[url] = "failed"; return ""


def _q(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"')


def known_keys(urls):
    """Canonical keys among `urls` already in the registry or frontier (OR-chain queries)."""
    known = set()
    pairs = [(u, canonical_url(u)) for u in urls]
    for place in ("p-scout-registry", "p-scout-frontier"):
        for i in range(0, len(pairs), 40):
            chunk = pairs[i:i + 40]
            where = " OR ".join('$.canonicalUrl == "%s" OR $.url == "%s"' % (_q(c), _q(u)) for u, c in chunk)
            for t in tokens_with_meta(place, 500, where=where):
                d = t.get("data") or {}
                known.add(d.get("canonicalUrl") or canonical_url(d.get("url", "")))
    return known


SITEMAP_CANDIDATES = ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap-index.xml")
CHILD_PREFER = ("post", "article", "blog", "news", "stories")
CHILD_EXCLUDE = ("image", "video", "category", "tag", "author", "attachment", "product-cat",
                 "page-sitemap", "misc", "local", "web-stories")
URL_EXCLUDE_SUFFIX = (".xml", ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".zip", ".mp4")
LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)
IS_INDEX = re.compile(r"<\s*sitemapindex", re.I)


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
    """Return (article_urls, sitemaps_used, listed_count, discovery) for one host, within budget.
    discovery: parsed | no-sitemap | fetch-failed."""
    urls, used, listed = [], [], 0
    found = discover_sitemaps(host)
    if not found:
        statuses = {FETCH_STATUS.get(u, "") for u in FETCH_STATUS if host in u}
        return [], [], 0, ("fetch-failed" if any(x in ("failed", "blocked", "size-capped") for x in statuses) else "no-sitemap")
    seen_c = set()
    for sm_url in found:
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
                cu = canonical_url(loc)
                if cu in seen_c or cu in known:
                    continue
                seen_c.add(cu)
                urls.append(loc)
                if len(urls) >= min(URLS_PER_HOST * 2, budget * 2):
                    break
        break  # one working sitemap tree per host is enough
    # One existence query per chunk instead of a registry scan; the crawl's own history decides.
    already = known_keys(urls)
    urls = [u for u in urls if canonical_url(u) not in already][:min(URLS_PER_HOST, budget)]
    known.update(canonical_url(u) for u in urls)
    return urls, used, listed, ("parsed" if used else "fetch-failed")


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"kind": "sitemap-harvest", "ts": ts, "queued": 0, "hosts": 0}

    brief = load_brief()
    deny = {h.lower().replace("www.", "") for h in (brief.get("denyHosts") or [])}

    # Onboarding requests are consumed once processed; the durable host list lives in sources.
    requests_meta = tokens_with_meta("p-scout-source-requests", 100)
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
    # A host a human set to index-only or ignore is not harvested: harvesting exists to find
    # articles to classify, and both policies say "do not classify this host".
    policies, policy_err = load_policies()
    out["policyLoadFailed"] = bool(policy_err)
    turned_off = [h for h in hosts if policies.get(h) in ("index-only", "ignore")]
    hosts = [h for h in hosts if h not in turned_off]
    out["hostsSkippedByPolicy"] = len(turned_off)

    # Known keys are looked up per host with targeted queries (known_keys); this set only
    # carries what THIS run queued so two hosts cannot queue the same page.
    known = set()

    budget = MAX_TOTAL
    per_host = []
    for h in hosts:
        if budget <= 0:
            break
        urls, used, listed, discovery = harvest_host(h, known, budget)
        queued, failed = 0, 0
        for i, u in enumerate(urls):
            try:
                api("POST", "/api/runtime/places/p-scout-frontier/tokens?modelId=" + MODEL,
                    {"name": "sitemap-%s-%d-%s" % (h.replace(".", "-"), i, ts.replace(":", "")),
                     "data": {"url": u, "canonicalUrl": canonical_url(u), "depth": 0, "attempt": 0,
                              "discoveredFrom": "sitemap", "briefId": brief.get("briefId", ""), "queuedAt": ts}})
                queued += 1
            except MasterError as e:
                failed += 1
                _record("queue", "%s %s" % (e.status, e.body))
        budget -= queued
        per_host.append({"host": h, "sitemaps": used, "listed": listed, "queued": queued,
                         "queueFailed": failed, "discovery": discovery})

    # Requests are fulfilled — remove them so a weekly sweep does not re-announce old asks.
    for t in requests_meta:
        try:
            api("DELETE", "/api/runtime/places/p-scout-source-requests/tokens/%s?modelId=%s"
                % (t.get("id"), MODEL))
        except MasterError as e:
            _record("request cleanup", "%s %s" % (e.status, e.body))

    out.update(queued=sum(p["queued"] for p in per_host), hosts=len(per_host),
               queueFailed=sum(p["queueFailed"] for p in per_host),
               requestsProcessed=len(requests_meta), perHost=per_host, outcome="ok")
    finish(out)


if __name__ == "__main__":
    main_guard(main, {"kind": "sitemap-harvest", "queued": 0, "hosts": 0})
