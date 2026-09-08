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
_shared_host_of = host_of


def host_of(url):
    return _shared_host_of(url, "?")


def replace_generation(place, tokens, run_id):
    """Write-then-sweep: insert the new generation stamped with runId, verify, then delete only
    tokens of older generations. A failure between the steps leaves the previous generation in
    place instead of an empty one (deleteAll-then-insert emptied the place on any error)."""
    try:
        for i in range(0, len(tokens), 100):
            api("POST", "/api/runtime/places/%s/tokens/bulk?modelId=%s" % (place, MODEL), {"tokens": tokens[i:i + 100]})
        old = [t for t in tokens_with_meta(place, 5000, critical=True) if (t.get("data") or {}).get("runId") != run_id]
        for t in old:
            api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (place, token_id(t), MODEL))
        return True
    except MasterError as e:
        _record("replace " + place, "%s %s" % (e.status, e.body))
        return False


BUCKETS = {"brand-new": "p-find-brand-new", "recent": "p-find-recent", "archive": "p-find-archive"}
TOP_TITLES = 3
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
    brief0 = load_brief()
    brand_days = int(brief0.get("brandNewDays") or 7)
    recent_days = int(brief0.get("recentDays") or 90)
    brief_id = brief0.get("briefId", "")
    # The brief's categories are the allowed set; entries may be "name | description".
    allowed_cats = {str(c).split("|")[0].strip().lower() for c in (brief0.get("categories") or []) if str(c).strip()}
    # A retry lane re-issues this rollup after the analysis lane answered without DONE. That
    # run exists precisely because the CURRENT corpus has no analysis, so the unchanged/fresh
    # rule must not swallow it; only the daily bound may.
    retry_reason = env_str("RETRY_REASON")
    forced = bool(retry_reason) or env_str("FORCE").lower() in ("1", "true")
    # A rollup taken mid-crawl analyses half a corpus at the expensive tier: defer while the
    # frontier is non-empty (the Monday recrawl and the monthly harvest both flood it).
    frontier_busy = bool(tokens_with_meta("p-scout-frontier", 1))
    if frontier_busy and not forced:
        finish({"findings": 0, "categories": 0, "competitors": 0, "ownArticles": 0, "rebucketed": 0,
                "ts": ts, "briefId": brief_id, "skipped": "frontier-busy", "frontierBusy": True}); return

    # RE-BUCKET FIRST: recency was stamped at filing time and findings age in place — without
    # this, a "brand-new" bucket quietly fills with month-old articles and every freshness
    # number downstream lies. Move = create in the right bucket, then delete the original.
    moved, rebucket_failed = 0, 0
    for recency, place in BUCKETS.items():
        for tok in tokens_with_meta(place, 5000):
            d = tok.get("data") or {}
            want = recency_for(d.get("publishedAt"), brand_days, recent_days)
            if want == recency:
                continue
            clean = {k: v for k, v in d.items() if not k.startswith("_")}
            clean["movedFrom"] = place
            # Delete THEN create: a token lost between the two is recoverable from the event
            # line; a token duplicated into two buckets silently corrupts every count.
            try:
                api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (place, token_id(tok), MODEL))
                api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (BUCKETS[want], MODEL),
                    {"name": tok.get("name"), "data": clean})
                moved += 1
            except MasterError as e:
                rebucket_failed += 1
                _record("rebucket " + place, "%s %s" % (e.status, e.body))
                continue

    findings, truncated, seen_keys, duplicates = [], False, set(), 0
    for recency, place in BUCKETS.items():
        rs = rows(place, 5000)
        if len(rs) >= 5000:
            truncated = True   # the numbers below are then a sample; the facts token says so
        for d in rs:
            key = d.get("canonicalUrl") or canonical_url(d.get("url", ""))
            if key in seen_keys:
                duplicates += 1
                continue
            seen_keys.add(key)
            d["_recency"] = recency
            findings.append(d)
    unknown_cats = 0
    for d in findings:
        cat = (d.get("category") or "uncategorised").strip().lower()
        if allowed_cats and cat not in allowed_cats and cat != "unrelated":
            cat = "uncategorised"; unknown_cats += 1
        d["category"] = cat

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
               "ownArticles": len(owned), "rebucketed": moved, "rebucketFailed": rebucket_failed,
               "duplicatesDropped": duplicates, "unknownCategoryCount": unknown_cats,
               "truncated": truncated, "briefId": brief_id, "frontierBusy": False, "ts": ts}
    if not findings:
        finish(summary); return

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
    by_host = defaultdict(list)
    for f in findings:
        by_host[host_of(f.get("url", ""))].append(f)
    per_host = {}
    for h in hosts:
        hf = by_host[h]
        per_host[h] = {
            "articles": len(hf),
            "categories": sorted({(f.get("category") or "uncategorised").lower() for f in hf}),
            "brandNew": sum(1 for f in hf if f["_recency"] == "brand-new"),
            "recent": sum(1 for f in hf if f["_recency"] == "recent"),
        }
    # Source profiles: one token per host — the provenance table and the expansion evidence.
    src_profiles = []
    for h in sorted(hosts):
        hf = by_host[h]
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
    replace_generation(SOURCES_PLACE, [{"data": {**p, "generatedAt": ts, "runId": ts}} for p in src_profiles], ts)

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
        "briefId": brief_id,
        "truncated": truncated,
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
        # keep the series bounded without a retain postset (this place has no producing lane)
        gt = sorted(tokens_with_meta(GROWTH_PLACE, 1000), key=lambda t: str((t.get("data") or {}).get("ts") or ""))
        for t in gt[:-GROWTH_KEEP]:
            api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (GROWTH_PLACE, token_id(t), MODEL))
    except MasterError as e:
        _record("growth", "%s %s" % (e.status, e.body))

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
    fallbacks_today = sum(1 for e in rows(ERRORS_PLACE, 200, where='$.reason == "analysis-fallback"')
                          if str(e.get("filedAt") or "")[:10] == ts[:10])
    exhausted = fallbacks_today >= MAX_ANALYSIS_RETRIES
    skip_digest = exhausted or (not forced and unchanged and digest_recent)
    summary["analysisFallbacksToday"] = fallbacks_today
    if forced:
        summary["retryReason"] = retry_reason

    try:
        for ct in cat_tokens:
            ct["data"]["runId"] = ts
        if not replace_generation("p-scout-taxonomy", cat_tokens, ts):
            raise MasterError(0, "category tokens not replaced")
        if skip_digest:
            summary["digest"] = (("skipped: analysis fell back %d times today; no more re-runs "
                                  "until tomorrow" % fallbacks_today) if exhausted
                                 else "skipped: corpus unchanged and analysis fresh (<7d)")
            raise StopIteration  # jump past the facts write; category tokens are already in
        # The digest lane binds exactly this token; everything it needs is inside it as
        # one JSON string, so the agent needs no extra queries.
        api("POST", "/api/runtime/places/p-scout-taxonomy/tokens?modelId=" + MODEL,
            {"name": "facts", "data": {"kind": "facts", "generatedAt": ts, "runId": ts,
                                       "briefId": brief_id, "truncated": truncated,
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
        summary["outcome"] = "failed"

    summary.update(sourcesByType=dict(by_type),
                   categories=len(by_cat), competitors=len(per_host),
                   recencySplit=facts["recencySplit"],
                   freshCards=len(fresh_articles),
                   freshTextArticles=with_text, freshTextChars=used,
                   freshTextSkipped=skipped, ownArticles=len(owned),
                   ownCovered=sum(1 for f in findings if f["_covered"]),
                   ownUncovered=sum(1 for f in findings if not f["_covered"]))
    finish(summary)


if __name__ == "__main__":
    main_guard(main, {"findings": 0, "categories": 0, "competitors": 0, "ownArticles": 0, "rebucketed": 0})
