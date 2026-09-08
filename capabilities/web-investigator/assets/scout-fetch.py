#!/usr/bin/env python3
"""scout-fetch — fetch ONE url, date it, score it, blob it, discover links.

Runs on the executor via the script-tool runtime (stdin closed, input via args.env).
Stdlib only: the executor host is not guaranteed to have third-party packages.

Prints ONE small JSON object to stdout. Small is load-bearing: executor stdout over
~128KB is auto-offloaded to a blob and REPLACES the whole payload, which would destroy
the routing fields. Full article text goes to the blobstore explicitly; only metadata
and a short extract are printed.

5.2.0: per-host policy from the dashboard (p-scout-source-policy) — ignore skips the fetch,
index-only fetches for links but never classifies; both are visible in telemetry.
5.1.0: the gate discriminates. Relevance is topic fit x PAGE SHAPE (prose ratio, length), so
a spec sheet or product grid that merely uses the right words no longer passes; pages that
are mostly fragments are typed `catalog` and rejected before any model sees them. Dates are
also read from the URL path, and the extract grows to the article's opening so the
classifier's summary and key points carry real knowledge.
"""
import json, os, re, sys, time, socket, gzip, io
import urllib.request, urllib.error
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, urldefrag, parse_qsl

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
emit = finish  # every exit path prints through finish() so libErrors ride out


UA = "AgenticNetOS-ResearchScout/1.0 (+local)"
MAX_BYTES = 2_000_000
TIMEOUT = 20
MAX_LINKS = 25
# The extract is what the classifier reads AND what its summary/keyPoints are distilled from,
# so it is the knowledge a finding keeps. 2,400 chars is an article's opening (thesis, framing),
# not its bulk; the full text stays in the blob. Rejected pages carry it too, for tuning.
EXTRACT_CHARS = 2400
# Below this share of sentence-shaped text a page is a catalogue/spec/listing, not an article.
CATALOG_PROSE_RATIO = 0.3
# The dashboard's per-host judgment: allow (default) | index-only (fetch for its links, never
# classify) | ignore (never fetch). Newest policy per host wins; the place is an audit log.
POLICY_PLACE = "p-scout-source-policy"


# Transient classes get requeued; permanent ones never do.
TRANSIENT = {"timeout", "dns", "http-429", "http-5xx", "tls"}
MAX_ATTEMPT = 3


def _q(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"')


def registry_lookup(url):
    """(etag, lastModified, tokenId, failed). Newest ledger entry for this page, matched by its
    canonical key (new rows) OR the raw url (rows written before canonical keys existed).
    The engine has no upsert-by-key, so the ledger is kept at one token per URL by deleting the
    previous entry before writing a new one; newest-first matters because a stale duplicate
    would hand back an expired etag and defeat the conditional GET."""
    c = canonical_url(url)
    try:
        q = {"arcql": 'FROM $ WHERE $.canonicalUrl == "%s" OR $.url == "%s" ORDER BY $.seenAt DESC LIMIT 1'
             % (_q(c), _q(url)), "limit": 1}
        res = api("POST", "/api/runtime/places/p-scout-registry/tokens/query?modelId=" + MODEL, q)
        for t in (res.get("tokens") or []):
            d = t.get("data") or {}
            return d.get("etag") or "", d.get("lastModified") or "", token_id(t), False
        return "", "", "", False
    except MasterError as e:
        _record("registry lookup", "%s %s" % (e.status, e.body))
        return "", "", "", True


def registry_upsert(url, etag, last_mod, outcome, prev_id=""):
    """Replace the ledger entry (delete-then-insert, there is no upsert). Returns False when the
    write failed, so the caller can say registryWriteFailed instead of re-fetching forever."""
    ok = True
    if prev_id:
        try:
            api("DELETE", "/api/runtime/places/p-scout-registry/tokens/%s?modelId=%s" % (prev_id, MODEL))
        except MasterError as e:
            _record("registry delete", "%s %s" % (e.status, e.body))
    try:
        api("POST", "/api/runtime/places/p-scout-registry/tokens?modelId=" + MODEL,
            {"data": {"url": url, "canonicalUrl": canonical_url(url), "etag": etag or "",
                      "lastModified": last_mod or "", "lastOutcome": outcome, "seenAt": now_iso()}})
    except MasterError as e:
        _record("registry write", "%s %s" % (e.status, e.body)); ok = False
    return ok


# --- source-type detection (deterministic; the provenance dimension of every finding) -------
FORUM_MARKERS = ("discourse", "phpbb", "vbulletin", "xenforo", "flarum", "nodebb", "mybb",
                 "vanilla forums", "/viewtopic.php", "showthread.php")
SHOP_MARKERS = ("cdn.shopify", "woocommerce", "add-to-cart", "addtocart", "bigcommerce",
                "magento", "cart-drawer")
NEWS_LD = ("newsarticle", "reportagenewsarticle", "newsmediaorganization")


def detect_source_type(url, meta, ld_types, html_low):
    host = ""
    try:
        host = url.split("/")[2].lower().replace("www.", "")
    except Exception:
        pass
    for hosts, kind in SOURCE_HOSTS:
        if any(h in host for h in hosts):
            return kind
    path = url.split(host, 1)[-1].lower() if host else url.lower()
    if any(seg in path for seg in ("/forum", "/forums", "/community/", "/thread", "/topic/", "/t/")):
        return "forum"
    gen = (meta.get("generator") or "").lower()
    og = (meta.get("og:type") or "").lower()
    if any(m in gen or m in html_low for m in FORUM_MARKERS):
        return "forum"
    if any(t in NEWS_LD for t in ld_types) or og == "article" and "news" in host:
        return "news"
    if any(t in ("product", "offer", "store", "onlinestore") for t in ld_types)             or any(m in html_low for m in SHOP_MARKERS):
        return "commercial"
    if og == "video.other" or any(t == "videoobject" for t in ld_types):
        return "video"
    if "wordpress" in gen or "ghost" in gen or "hugo" in gen or "jekyll" in gen             or og in ("article", "blog") or any(t in ("blogposting", "article") for t in ld_types):
        return "blog"
    if any(t == "faqpage" or t == "howto" for t in ld_types):
        return "docs"
    return "other"


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


URL_DATE = re.compile(r"/((?:19|20)\d{2})/(\d{1,2})(?:/(\d{1,2}))?(?=/|$)"
                      r"|/((?:19|20)\d{2})-(\d{2})-(\d{2})(?=[/\-_.]|$)")


def url_date(url):
    """A date the site wrote into its own URL (/2024/05/12/slug, /2024-05-12-slug). A day-less
    path (/2024/05/) takes the 1st: precise enough for a 90-day recency window, and far better
    than filing the page as undated archive."""
    path = urlparse(url).path
    now = datetime.now(timezone.utc)
    for m in URL_DATE.finditer(path):
        y, mo, d = (m.group(1), m.group(2), m.group(3)) if m.group(1) else (m.group(4), m.group(5), m.group(6))
        try:
            dt = datetime(int(y), int(mo), int(d or 1), tzinfo=timezone.utc)
        except ValueError:
            continue
        if datetime(1995, 1, 1, tzinfo=timezone.utc) <= dt <= now + timedelta(days=2):
            return dt
    return None


def find_date(ex, headers, url=""):
    """Return (datetime, source, key). Source is the strategy; key is the exact meta name or
    header that won, which is what makes the health rollup's undated-share hint actionable."""
    for k in ("article:published_time", "og:published_time", "article:published",
              "datepublished", "parsely-pub-date", "sailthru.date", "citation_publication_date",
              "dc.date.issued", "dcterms.created", "dcterms.date", "publish-date", "publishdate",
              "article:modified_time", "date", "dc.date", "pubdate"):
        d = parse_date(ex.meta.get(k))
        if d:
            return d, ("og" if k.startswith(("article:", "og:")) else "meta"), k
    for blob in ex.ld:
        try:
            obj = json.loads(blob)
        except Exception:
            continue
        for node in (obj if isinstance(obj, list) else [obj]):
            if isinstance(node, dict):
                d = parse_date(node.get("datePublished") or node.get("dateCreated"))
                if d:
                    return d, "json-ld", "datePublished" if node.get("datePublished") else "dateCreated"
    d = parse_date(ex.meta.get("__time"))
    if d:
        return d, "time-tag", "time[datetime]"
    d = url_date(url)
    if d:
        return d, "url", "path"
    d = parse_http_date(headers.get("Last-Modified", ""))
    if d:
        return d, "header", "Last-Modified"
    return None, "none", ""


def page_shape(pieces):
    """How much of a page is PROSE. A spec sheet, a product grid or a listing is mostly labels,
    values and link text (short fragments); an article is sentences. The share of characters
    inside sentence-length fragments separates the two without knowing one word of the domain,
    which is what lets the gate turn catalogue pages away before they cost a model call."""
    total = sum(len(p) for p in pieces) or 1
    prose = 0
    for p in pieces:
        w = len(p.split())
        if w >= 12 or (w >= 7 and p.rstrip()[-1:] in ".!?"):
            prose += len(p)
    toks = [t for p in pieces for t in p.split()]
    numeric = sum(1 for t in toks if any(ch.isdigit() for ch in t)) / (len(toks) or 1)
    return {"proseRatio": round(prose / total, 3), "numericDensity": round(numeric, 3),
            "wordCount": len(toks)}


def article_start(text, title):
    """Skip site chrome: an article's body usually begins at the last occurrence of its own
    title. Only trusted when that sits in the first 60% of the page."""
    key = " ".join((title or "").split()[:6])
    if key and len(key) > 12:
        i = text.rfind(key)
        if 0 <= i < len(text) * 0.6:
            return text[i:]
    return text


def score_text(title, text, brief, shape=None):
    """0-100 = topic fit x article shape. Topic fit alone saturates on any on-topic site,
    because every page there uses the brief's own vocabulary (measured: 100% of pages scored
    exactly 100), so shape is what makes minScore a real gate: a 300-word spec sheet with the
    right words lands around 20, a short article around 60-70, a full one 90-100."""
    inc = [t.lower() for t in (brief.get("mustInclude") or []) if t.strip()]
    exc = [t.lower() for t in (brief.get("mustExclude") or []) if t.strip()]
    hay, head = text.lower(), title.lower()
    for t in exc:
        if t in hay or t in head:
            return 0
    words = max(1, len(text.split()))
    if inc:
        present = sum(1 for t in inc if t in hay or t in head)
        per_thousand = sum(hay.count(t) for t in inc) * 1000.0 / words
        topic = 0.6 * (present / len(inc)) + 0.4 * min(1.0, per_thousand / 6.0)
    else:
        topic = 0.5
    if shape:
        topic *= min(1.0, shape["proseRatio"] / 0.6) * min(1.0, shape["wordCount"] / 500.0)
    return int(round(100 * topic))


def spool_links(links, parent_url, parent_depth, brief, policies=None):
    """Queue newly discovered URLs into the frontier, deduped. Runs INLINE here rather
    than in a downstream lane because a JSON string cannot survive a map template into
    args.env: the engine auto-parses JSON-looking strings and type preservation re-emits
    an array, which the executor drops. Doing it here also saves an executor round trip.
    Returns counters that ride out on the result token and into telemetry."""
    # Counters ONLY. Anything else here is merged over `out` by the caller and would silently
    # reset a field computed earlier — that is how sourceType stayed empty on 1300 findings.
    c = {"spoolQueued": 0, "spoolKnown": 0, "spoolFiltered": 0, "spoolDepthStopped": 0,
         "spoolMalformed": 0, "spoolCapped": 0, "spoolDeferred": 0, "dedupeDegraded": False,
         "frontierCandidates": []}
    child = parent_depth + 1
    # Depth capped with < (never !=): != also matches missing and overshoot.
    if child >= int(brief.get("maxDepth") or 3):
        c["spoolDepthStopped"] = len(links)
        return c

    deny = {h.lower().replace("www.", "") for h in (brief.get("denyHosts") or [])}
    allow = {h.lower().replace("www.", "") for h in (brief.get("allowHosts") or [])}
    same_host = bool(brief.get("sameHostOnly"))
    phost = host_of(parent_url)

    # Pass 1: cheap local filters, keyed by the canonical form (six spellings of one page are one).
    cands, seen_c = [], set()
    for u in links:
        # Untrusted web content enters the queue here and nowhere else.
        if len(u) > 2048 or any(ch in u for ch in '"\\<>{}|^`') or any(ord(ch) < 0x20 for ch in u):
            c["spoolMalformed"] += 1
            continue
        h = host_of(u)
        if h in deny or (allow and h not in allow) or (same_host and phost and h != phost) \
                or (policies or {}).get(h) == "ignore":
            c["spoolFiltered"] += 1
            continue
        cu = canonical_url(u)
        if cu in seen_c:
            c["spoolKnown"] += 1
            continue
        seen_c.add(cu)
        cands.append((u, cu))

    # Pass 2: ONE frontier scan (small: the queue) and ONE registry existence query over the
    # candidates, matching canonical keys and legacy raw urls. No 3000-row registry scan, no
    # ceiling past which dedupe silently degrades.
    known = set()
    frontier = tokens_with_meta("p-scout-frontier", 3000)
    for t in frontier:
        d = t.get("data") or {}
        known.add(d.get("canonicalUrl") or canonical_url(d.get("url", "")))
    frontier_n = len(frontier)
    degraded = False
    if cands:
        where = " OR ".join('$.canonicalUrl == "%s" OR $.url == "%s"' % (_q(cu), _q(u)) for u, cu in cands)
        hits = tokens_with_meta("p-scout-registry", 500, where=where)
        if LIB_ERRORS and any(e.startswith("read p-scout-registry") for e in LIB_ERRORS[-1:]):
            degraded = True
        for t in hits:
            d = t.get("data") or {}
            known.add(d.get("canonicalUrl") or canonical_url(d.get("url", "")))
    c["dedupeDegraded"] = degraded

    fresh = []
    for u, cu in cands:
        if cu in known:
            c["spoolKnown"] += 1
            continue
        if degraded:
            # Cannot tell new from known: queueing would restore the re-fetch storm. Deferred, counted.
            c["spoolDeferred"] += 1
            continue
        if frontier_n + len(fresh) >= 2000:
            c["spoolCapped"] += len(cands) - len(fresh) - c["spoolKnown"] - c["spoolDeferred"]
            break
        fresh.append(u)

    if fresh:
        # The NET queues these, not this script: the lift lane emits them with fanOut:true,
        # one token per element, so link discovery is a visible arc on the canvas instead of
        # a hidden POST. We still CLAIM them in the registry here, because dedupe must happen
        # at queue time — a URL is invisible between leaving the frontier and its post-fetch
        # registry write, and concurrent fetches re-queue popular nav pages repeatedly
        # (measured: 118 fetches for 57 URLs, one page 6x).
        c["frontierCandidates"] = [
            {"url": u, "canonicalUrl": canonical_url(u), "depth": child, "attempt": 0,
             "discoveredFrom": parent_url, "briefId": brief.get("briefId", ""), "queuedAt": now_iso()}
            for u in fresh]
        c["spoolQueued"] = len(fresh)
        try:
            api("POST", "/api/runtime/places/p-scout-registry/tokens/bulk?modelId=" + MODEL,
                {"tokens": [{"data": {"url": u, "canonicalUrl": canonical_url(u), "etag": "",
                                      "lastModified": "", "lastOutcome": "queued", "seenAt": now_iso()}}
                            for u in fresh]})
        except MasterError as e:
            _record("registry claim", "%s %s" % (e.status, e.body))
    return c


LISTING_PARAMS = {"page", "paged", "s", "q", "search", "tag", "cat", "category", "sort", "orderby", "filter"}


def article_likeness(u, base_host):
    """Rank candidate links on an index page: article-shaped URLs first, chrome last."""
    try:
        p = urlparse(u)
    except Exception:
        return -9
    seg = [x for x in p.path.split("/") if x]
    score = 0
    if p.netloc.lower().replace("www.", "") == base_host.lower().replace("www.", ""):
        score += 2
    if len(seg) >= 2:
        score += 2
    if seg and "-" in seg[-1] and len(seg[-1]) > 12:
        score += 2
    if seg and seg[-1].lower().rsplit(".", 1)[-1] in ("html", "htm"):
        score += 1
    if {k.lower() for k, _ in parse_qsl(p.query)} & LISTING_PARAMS:
        score -= 3
    if seg and seg[0].lower() in ("category", "tag", "author", "page", "search", "wp-content", "feed"):
        score -= 3
    return score


def classify_page(url):
    """index vs article. A listing page (site root, /category/, /tag/, /blog/, /page/2/)
    has no publication date and is not a competitor ARTICLE — but it is still worth
    fetching for its links. Categorising one costs a model call and files a fake finding:
    measured 34 of 156 findings were listing pages, and one competitor's entire presence
    turned out to be index pages with no articles behind them."""
    p = urlparse(url)
    path = p.path or "/"
    if path in ("", "/"):
        return "index"
    # A query string is a listing only when it carries listing parameters; ?p=123 permalinks and
    # campaign parameters (dropped by the canonical key anyway) are still articles.
    qs = {k.lower() for k, _ in parse_qsl(p.query, keep_blank_values=True)}
    if qs & LISTING_PARAMS:
        return "index"
    seg = [x for x in path.split("/") if x]
    if not seg:
        return "index"
    if len(seg) == 1 and seg[0].lower() in ("category", "tag", "author", "blog", "topics", "archives", "search"):
        return "index"
    if len(seg) >= 2 and seg[-2].lower() == "page" and seg[-1].isdigit():
        return "index"
    return "article"


ROBOTS_MAX_BYTES = 200_000
ROBOTS_UA_TOKEN = "agenticnetos-researchscout"


def robots_rules(url, opener):
    """(disallowed_paths, crawl_delay) for our agent on this host, honouring the `*` group and any
    group that names our token. Any failure means no rules (a site without robots.txt is open)."""
    try:
        p = urlparse(url)
        rurl = "%s://%s/robots.txt" % (p.scheme, p.netloc)
        ok, _ = safe_url(rurl)
        if not ok:
            return [], 0
        req = urllib.request.Request(rurl, method="GET")
        req.add_header("User-Agent", UA)
        with opener.open(req, timeout=10) as r:
            raw = read_bounded(r, ROBOTS_MAX_BYTES)
        text = raw[:ROBOTS_MAX_BYTES].decode("utf-8", "replace")
    except Exception:
        return [], 0
    groups, cur, applies = [], None, False
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        k, v = [x.strip() for x in line.split(":", 1)]
        k = k.lower()
        if k == "user-agent":
            if cur is None or cur["closed"]:
                cur = {"agents": [], "disallow": [], "delay": 0, "closed": False}
                groups.append(cur)
            cur["agents"].append(v.lower())
        elif cur is not None:
            cur["closed"] = True
            if k == "disallow" and v:
                cur["disallow"].append(v)
            elif k == "crawl-delay":
                try:
                    cur["delay"] = float(v)
                except ValueError:
                    pass
    mine = [g for g in groups if any(ROBOTS_UA_TOKEN in a for a in g["agents"])]
    use = mine or [g for g in groups if "*" in g["agents"]]
    dis, delay = [], 0
    for g in use:
        dis += g["disallow"]
        delay = max(delay, g["delay"])
    return dis, delay


def robots_blocks(url, disallowed):
    path = urlparse(url).path or "/"
    return any(path.startswith(d) for d in disallowed if d)


def contract(url="", depth=0, attempt=0, brief_id=""):
    """Every key the lift lane reads, initialised, so no placeholder ever renders empty."""
    try:
        host = urlparse(url).netloc
    except ValueError:
        host = ""
    return {"url": url, "host": host, "canonicalUrl": canonical_url(url) if url else "", "finalUrl": "",
            "depth": depth, "attempt": attempt, "briefId": brief_id, "ts": now_iso(), "outcome": "error",
            "failureClass": "none", "httpStatus": 0, "durationMs": 0, "bytes": 0, "contentType": "",
            "charset": "", "replacementRatio": 0, "title": "", "publishedAt": "", "ageDays": -1,
            "recency": "archive", "dateSource": "none", "dateKey": "", "score": 0, "extract": "",
            "blobUrn": "", "blobError": "", "extractChars": 0, "linksFound": 0, "discoveredUrls": [],
            "proseRatio": 0, "numericDensity": 0, "wordCount": 0,
            # Pre-serialised because args.env values must be STRINGS: a template can only
            # preserve the array type, and the executor drops a non-string env value.
            "discoveredJson": "[]", "retry": "no",
            "spoolQueued": 0, "spoolKnown": 0, "spoolFiltered": 0, "spoolDepthStopped": 0,
            "spoolMalformed": 0, "spoolCapped": 0, "spoolDeferred": 0, "dedupeDegraded": False,
            "frontierCandidates": [], "pageType": "article", "gateVerdict": "low-score", "sourceType": "",
            "policyLoadFailed": False, "registryLookupFailed": False, "registryWriteFailed": False,
            "robotsChecked": False, "error": ""}


def main():
    url = env_str("URL")
    depth = env_int("DEPTH")
    attempt = env_int("ATTEMPT")
    brief = load_brief()
    out = contract(url, depth, attempt, brief.get("briefId", ""))

    if not url:
        out["failureClass"] = "no-url"
        emit(out); return
    try:
        urlparse(url)
    except ValueError:
        out.update(outcome="failed", failureClass="malformed-url")
        emit(out); return

    def fail_permanent(cls, etag="", last_mod="", prev_id=""):
        out.update(outcome="failed", failureClass=cls)
        if not registry_upsert(url, etag, last_mod, cls, prev_id):
            out["registryWriteFailed"] = True
        emit(out)

    # Address gate BEFORE any network use: discovered links are untrusted, and a seed can be typed.
    ok, why = safe_url(url)
    if not ok:
        if why == "dns":
            out.update(outcome="failed", failureClass="dns")
            if attempt + 1 < MAX_ATTEMPT:
                out.update(retry="yes", attempt=attempt + 1)
            emit(out); return
        fail_permanent("blocked-address"); return

    policies, policy_err = load_policies()
    out["policyLoadFailed"] = bool(policy_err)
    policy = policy_for(url, policies)
    etag, last_mod, prev_id, lookup_failed = registry_lookup(url)
    out["registryLookupFailed"] = lookup_failed
    if policy == "ignore":
        # A human said this host is not worth reading. Recorded in the registry so the URL is
        # never re-queued, and in telemetry so the decision is visible.
        out.update(outcome="skipped", failureClass="policy-ignore", gateVerdict="policy")
        if not registry_upsert(url, etag, last_mod, "policy-ignore", prev_id):
            out["registryWriteFailed"] = True
        emit(out); return

    opener, redirects = safe_opener()
    disallowed, delay = robots_rules(url, opener)
    out["robotsChecked"] = True
    if robots_blocks(url, disallowed):
        fail_permanent("robots-disallow", etag, last_mod, prev_id); return
    if delay > 0:
        time.sleep(min(delay, 5))

    started = time.time()
    fail = None
    status, headers, raw, final = 0, {}, b"", url
    try:
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", UA)
        req.add_header("Accept-Encoding", "gzip")
        if etag:
            req.add_header("If-None-Match", etag)
        if last_mod:
            req.add_header("If-Modified-Since", last_mod)
        with opener.open(req, timeout=TIMEOUT) as r:
            status, headers = r.status, dict(r.headers)
            final = r.geturl() or redirects.final_url or url
            raw = read_bounded(r, MAX_BYTES)
    except BlockedRedirect as e:
        fail = "blocked-address"; out["error"] = str(e)[:160]
    except urllib.error.HTTPError as e:
        status, headers, raw = e.code, dict(e.headers or {}), b""
        if status == 304:
            fail = None
        elif status < 400:
            fail = "redirect-loop"        # urllib raises the 3xx itself once max redirects is hit
        elif status == 429:
            fail = "http-429"
        elif status == 403:
            fail = "http-403-paywall"
        elif 400 <= status < 500:
            fail = "http-4xx"
        else:
            fail = "http-5xx"
    except socket.timeout:
        fail = "timeout"
    except socket.gaierror:
        fail = "dns"
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e)).lower()
        fail = ("timeout" if "timed out" in reason
                else "dns" if "name or service" in reason or "nodename" in reason or "gaierror" in reason
                else "tls" if "ssl" in reason or "certificate" in reason
                else "exception")
        out["error"] = reason[:160]
    except Exception as e:  # noqa: BLE001 - a programming error is reported as such, never as a transient dns failure
        fail = "exception"; out["error"] = repr(e)[:160]

    out["durationMs"] = int((time.time() - started) * 1000)
    out["httpStatus"] = status
    out["contentType"] = (headers.get("Content-Type") or "")[:80]

    if status == 304:
        out.update(outcome="not-modified", failureClass="ok")
        if not registry_upsert(url, etag, last_mod, "not-modified", prev_id):
            out["registryWriteFailed"] = True
        emit(out); return

    if fail:
        out.update(outcome="failed", failureClass=fail)
        if fail in TRANSIENT and attempt + 1 < MAX_ATTEMPT:
            out.update(retry="yes", attempt=attempt + 1)
        if not registry_upsert(url, etag, last_mod, fail, prev_id):
            out["registryWriteFailed"] = True
        emit(out); return

    # The page may have moved: policy, deny/allow and host rules apply to where we LANDED.
    if canonical_url(final) != canonical_url(url):
        out["finalUrl"] = final
        fhost = host_of(final)
        deny = {h.lower().replace("www.", "") for h in (brief.get("denyHosts") or [])}
        allow = {h.lower().replace("www.", "") for h in (brief.get("allowHosts") or [])}
        if policy_for(final, policies) == "ignore" or fhost in deny or (allow and fhost not in allow) \
                or (brief.get("sameHostOnly") and fhost != host_of(url)):
            out.update(gateVerdict="policy")
            fail_permanent("policy-filtered", headers.get("ETag", ""), headers.get("Last-Modified", ""), prev_id); return
        if robots_blocks(final, robots_rules(final, opener)[0]):
            fail_permanent("robots-disallow", headers.get("ETag", ""), headers.get("Last-Modified", ""), prev_id); return

    if headers.get("Content-Encoding", "").lower() == "gzip" or raw[:2] == b"\x1f\x8b":
        try:
            raw = gunzip_bounded(raw, MAX_BYTES)
        except SizeCapped:
            fail_permanent("size-capped", headers.get("ETag", ""), headers.get("Last-Modified", ""), prev_id); return
        except CorruptEncoding:
            fail_permanent("corrupt-encoding", headers.get("ETag", ""), headers.get("Last-Modified", ""), prev_id); return
    out["bytes"] = len(raw)
    if len(raw) > MAX_BYTES:
        fail_permanent("size-capped", headers.get("ETag", ""), headers.get("Last-Modified", ""), prev_id); return

    ctype = (headers.get("Content-Type") or "").lower()
    if "html" not in ctype and "xml" not in ctype and ctype:
        fail_permanent("non-html", headers.get("ETag", ""), headers.get("Last-Modified", ""), prev_id); return

    ex = Extract()
    html_text, codec, ratio = decode_body(raw, ctype)
    out["charset"], out["replacementRatio"] = codec, ratio
    try:
        ex.feed(html_text)
    except Exception:
        pass
    text = " ".join(ex.text)
    title = " ".join(ex.title.split())[:300]

    ld_types = []
    for blob in ex.ld:
        try:
            obj = json.loads(blob)
            for node in (obj if isinstance(obj, list) else [obj]):
                t = node.get("@type") if isinstance(node, dict) else None
                for x in (t if isinstance(t, list) else [t]):
                    if x:
                        ld_types.append(str(x).lower())
        except Exception:
            continue
    # Provenance survives even failed extracts: a forum that resists parsing is still a forum.
    out["sourceType"] = detect_source_type(url, ex.meta, ld_types, html_text[:60000].lower())

    if len(text) < 200:
        # Almost always a JS-rendered page. Recorded, not retried.
        out.update(title=title, extractChars=len(text))
        fail_permanent("empty-extract", headers.get("ETag", ""), headers.get("Last-Modified", ""), prev_id); return

    shape = page_shape(ex.text)
    out.update(shape)
    dt, src, dkey = find_date(ex, headers, url)
    out["dateKey"] = dkey
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

    page_type = classify_page(url)
    if page_type == "article" and shape["proseRatio"] < CATALOG_PROSE_RATIO:
        page_type = "catalog"

    # Links: dedupe by canonical key while collecting; on an index page rank article-shaped URLs
    # ahead of chrome before the cut, otherwise the first 25 anchors are the navigation.
    links, seen = [], set()
    base_host = urlparse(url).netloc
    for h in ex.links:
        try:
            absu = urldefrag(urljoin(url, h))[0]
            p = urlparse(absu)
        except Exception:
            continue
        if p.scheme not in ("http", "https"):
            continue
        cu = canonical_url(absu)
        if cu in seen:
            continue
        seen.add(cu)
        links.append(absu)
        if len(links) >= 400:
            break
    if page_type == "index":
        links.sort(key=lambda u: -article_likeness(u, base_host))
    links = links[:MAX_LINKS]

    blob_urn = ""
    try:
        blob_urn = put_blob("URL: %s\nTITLE: %s\nPUBLISHED: %s\n\n%s"
                            % (url, title, out["publishedAt"], text))["urn"]
    except Exception as e:
        out["blobError"] = repr(e)[:120]

    out.update(spool_links(links, url, depth, brief, policies))
    score_val = score_text(title, text, brief, shape)
    try:
        min_score = int(brief.get("minScore") or 0)
    except Exception:
        min_score = 0
    # Collapsed to ONE literal the gate lane can route on.
    verdict = ("policy" if policy == "index-only"
               else "index" if page_type == "index" else "catalog" if page_type == "catalog"
               else "pass" if score_val >= min_score else "low-score")
    out.update(pageType=page_type, gateVerdict=verdict)
    body = article_start(text, title)
    extract = body[:EXTRACT_CHARS]
    if len(body) > EXTRACT_CHARS:
        extract = extract.rsplit(" ", 1)[0]
    out.update(outcome="ok", failureClass="ok", title=title, ageDays=age, recency=recency,
               dateSource=src, score=score_val,
               extract=extract, blobUrn=blob_urn, extractChars=len(text),
               linksFound=len(links), discoveredUrls=links,
               discoveredJson=json.dumps(links))
    if not registry_upsert(url, headers.get("ETag", ""), headers.get("Last-Modified", ""), "ok", prev_id):
        out["registryWriteFailed"] = True
    emit(out)


if __name__ == "__main__":
    main_guard(main, contract(env_str("URL"), env_int("DEPTH"), env_int("ATTEMPT")))
