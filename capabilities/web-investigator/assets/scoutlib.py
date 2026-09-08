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
