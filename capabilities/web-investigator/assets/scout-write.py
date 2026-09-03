#!/usr/bin/env python3
"""scout-write — draft ONE accepted article task with Claude Code, from a knowledge pack.

Everything deterministic happens here: pick the task, assemble a KNOWLEDGE PACK from the whole
corpus (not just the one competitor piece), find the owner's related articles, then invoke the
local `claude` binary headlessly (-p, no tools, no session persistence), store the article in
the blobstore and file a SMALL draft token that points at it. One draft per run bounds the
spend; a run with nothing eligible exits quietly, so the daily cron and the app's buttons are
all safe.

THE KNOWLEDGE PACK. Every finding already carries a summary and key points written at
classification time, and its full text sits in a blob. The pack ranks all findings against the
assignment (title, rationale, category) by term overlap, caps what one host may contribute, and
hands the writer three rings of evidence: the competitor piece to beat (body, clipped), the
best-matching passages of the next few sources (sentence windows ranked against the
assignment, pulled from their blobs), and compact cards for a wider ring of related pieces.
The pack itself is stored as a blob and referenced from the draft, so what the writer was
shown is auditable.

TOKENS STAY SMALL. The draft token carries the title, a preview, the heading outline, counts
and the blob urns — never the article. The dashboard reads the blob when someone opens it.

Two env knobs make one script serve several lanes:
  TASK_ID       draft THIS task (a human picked it in the app). Without it, the lane takes the
                oldest accepted task that has no draft yet — the unattended behaviour.
  WRITER_MODEL  model alias handed to `claude --model` (e.g. fable). Unset uses the binary's
                default. Naming it also marks the draft, so the app can show who wrote what and
                the same assignment can be re-drafted by a stronger model without losing the
                first attempt.

Dedupe is by the drafts ledger, never by consuming the task: the task token belongs to the
application's lifecycle (accepted -> done via complete-task) and must survive drafting. An
explicitly requested TASK_ID always writes — asking for a second draft is the point of asking.
"""
import json, os, re, shutil, subprocess
import urllib.request
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
BLOBS = os.environ.get("BLOB_URL", "http://127.0.0.1:8090").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")


def env_str(key):
    # An unset field interpolates through a map template as the literal 'null'; treat every
    # flavour of absent as absent.
    v = (os.environ.get(key) or "").strip()
    return "" if v.lower() in ("", "null", "none", "undefined") else v


TASK_ID = env_str("TASK_ID")
WRITER_MODEL = env_str("WRITER_MODEL")
COMPETITOR_CHARS = 4500     # the piece to beat, clipped
PASSAGE_SOURCES = 4         # further sources that contribute ranked passages
PASSAGE_CHARS = 2000        # per passage source
CARD_SOURCES = 14           # compact cards in the wider ring
PER_HOST_CAP = 6            # no single host may dominate the evidence
PASSAGE_HOST_CAP = 2        # and passages in particular come from different sites
MIN_MATCH = 0.2             # below this share of the assignment's terms a piece is noise
RELATED_MAX = 5
PREVIEW_CHARS = 600
CLAUDE_TIMEOUT_S = 420
FINDING_PLACES = ("p-find-brand-new", "p-find-recent", "p-find-archive")
# The executor may run with a minimal PATH; resolve the binary the way a user shell would.
CLAUDE_CANDIDATES = [shutil.which("claude"), os.path.expanduser("~/.local/bin/claude"),
                     os.path.expanduser("~/.claude/local/claude"),
                     "/usr/local/bin/claude", "/opt/homebrew/bin/claude"]
STOP = set("""a an the and or for to of in on with your you how what why when is are do does can
will vs best top guide review reviews com www html htm index page it its this that from by at as
be has have not one two three more most into than then them they their there these those which
who also just like get use using used""".split())
SENTENCE = re.compile(r"[A-Z][^.!?]{60,}?[.!?](?:\s|$)")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")
TITLE_SUFFIX = re.compile(r"\s*[-|–—]\s*[^-|–—]{0,40}\.(com|net|org|co|io)\s*$", re.I)
HEADING = re.compile(r"^(#{1,3})\s+(.+?)\s*$", re.M)


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
        return (url or "").split("/")[2].lower().replace("www.", "")
    except Exception:
        return ""


def terms(text, host=""):
    text = TITLE_SUFFIX.sub("", text or "")
    stop = set(STOP)
    stop.update(w for w in re.split(r"[^a-z0-9]+", (host or "").lower()) if len(w) > 2)
    return {w for w in re.split(r"[^a-z0-9]+", text.lower()) if w and w not in stop and len(w) > 2}


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
    start = 0
    key = " ".join((title or "").split()[:6])
    if key and len(key) > 12:
        i = text.rfind(key)
        if 0 <= i < len(text) * 0.6:
            start = i
    m = SENTENCE.search(text, start) or SENTENCE.search(text)
    return text[m.start():] if m else text


def put_blob(text):
    req = urllib.request.Request(BLOBS + "/api/blobs", data=text.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "text/plain; charset=utf-8")  # omit and the body is mangled
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def blob_text(urn):
    if not urn or "blob:" not in urn:
        return ""
    try:
        with urllib.request.urlopen(BLOBS + "/api/blobs/" + urn.split("blob:", 1)[1], timeout=25) as r:
            raw = r.read().decode("utf-8", "replace")
    except Exception:
        return ""
    body = raw.split("\n\n", 1)[1] if "\n\n" in raw[:400] else raw
    return " ".join(body.split())


# ---- the knowledge pack ---------------------------------------------------------------------

def rank_findings(want, category, findings, exclude_url=""):
    """Findings by how much of the ASSIGNMENT's vocabulary they cover (recall over the task's
    terms, so a long finding cannot win by sheer size), with a nudge for the same category and
    for freshness. One host may fill at most PER_HOST_CAP slots."""
    scored = []
    for f in findings:
        if not f.get("url") or f.get("url") == exclude_url or not want:
            continue
        h = host_of(f.get("url", ""))
        ft = terms(" ".join([f.get("title") or "", f.get("summary") or "",
                             " ".join(key_points(f.get("keyPoints")))]), h)
        hit = len(want & ft) / float(len(want))
        if hit <= 0:
            continue
        s = hit
        if category and (f.get("category") or "").lower() == category:
            s += 0.15
        if f.get("_recency") in ("brand-new", "recent"):
            s += 0.05
        scored.append((s, f))
    scored.sort(key=lambda x: -x[0])
    out, per_host = [], {}
    for s, f in scored:
        h = host_of(f["url"])
        if per_host.get(h, 0) >= PER_HOST_CAP:
            continue
        per_host[h] = per_host.get(h, 0) + 1
        out.append((round(s, 3), f))
    return out


def best_passages(text, want, budget):
    """Sentence windows (3 sentences each) ranked by how many assignment terms they carry,
    returned in document order up to the budget — the parts of a source that speak to THIS
    assignment, not its opening."""
    sents = [s.strip() for s in SENT_SPLIT.split(text) if len(s.strip()) > 30]
    if not sents:
        return ""
    windows = []
    for i in range(0, len(sents), 3):
        w = " ".join(sents[i:i + 3])
        if len(w) < 80:
            continue
        windows.append((len(want & terms(w)), i, w))
    windows.sort(key=lambda x: (-x[0], x[1]))
    picked, used = [], 0
    for score, i, w in windows:
        if score == 0 and picked:
            break
        if used + len(w) > budget:
            continue
        picked.append((i, w))
        used += len(w)
        if used >= budget * 0.85:
            break
    return " […] ".join(w for _, w in sorted(picked))


def knowledge_pack(task, findings, brief):
    host = host_of(task.get("competitorUrl", ""))
    category = (task.get("gapCategory") or "").lower()
    want = (terms(task.get("title", ""), host) | terms(task.get("rationale", ""), host)
            | terms(category.replace("-", " ")))
    ranked = rank_findings(want, category, findings, exclude_url=task.get("competitorUrl", ""))

    # Ring 1: the piece to beat — its stored text, or the finding that matches its URL.
    competitor = article_body(blob_text(task.get("blobUrn", "")), task.get("title", ""))
    if not competitor and task.get("competitorUrl"):
        hit = next((f for f in findings if f.get("url") == task["competitorUrl"] and f.get("blobUrn")), None)
        if hit:
            competitor = article_body(blob_text(hit["blobUrn"]), hit.get("title", ""))
    competitor = competitor[:COMPETITOR_CHARS]

    # Ring 2: ranked passages from the next best sources, pulled from their blobs.
    passages, hosts, passage_hosts = [], set(), {}
    for score, f in ranked:
        if len(passages) >= PASSAGE_SOURCES:
            break
        h = host_of(f["url"])
        if (score < MIN_MATCH or passage_hosts.get(h, 0) >= PASSAGE_HOST_CAP
                or (f.get("category") or "").lower() == "unrelated"):
            continue
        body = article_body(blob_text(f.get("blobUrn", "")), f.get("title", ""))
        text = best_passages(body, want, PASSAGE_CHARS) if body else ""
        if not text:
            continue
        passage_hosts[h] = passage_hosts.get(h, 0) + 1
        passages.append({"title": f.get("title", ""), "host": h, "url": f["url"],
                         "publishedAt": f.get("publishedAt", ""), "category": f.get("category", ""),
                         "match": score, "text": text})
        hosts.add(host_of(f["url"]))
    # Ring 3: compact cards for the wider field (never the ones already quoted).
    quoted = {p["url"] for p in passages}
    cards = []
    for score, f in ranked:
        if f["url"] in quoted or score < MIN_MATCH or (f.get("category") or "").lower() == "unrelated":
            continue
        if len(cards) >= CARD_SOURCES:
            break
        cards.append({"title": f.get("title", ""), "host": host_of(f["url"]),
                      "publishedAt": f.get("publishedAt", ""), "category": f.get("category", ""),
                      "summary": str(f.get("summary") or "")[:300],
                      "keyPoints": key_points(f.get("keyPoints")), "match": score})
        hosts.add(host_of(f["url"]))
    if host:
        hosts.add(host)
    return {"competitor": competitor, "passages": passages, "cards": cards,
            "sourcesUsed": (1 if competitor else 0) + len(passages) + len(cards),
            "hosts": sorted(h for h in hosts if h), "assignmentTerms": sorted(want)[:60]}


def pack_text(task, pack):
    lines = ["THE COMPETITOR PIECE THIS MUST BEAT (%s):" % task.get("competitorUrl", ""),
             pack["competitor"] or "(no stored text for the competitor piece)", ""]
    if pack["passages"]:
        lines.append("WHAT OTHER SOURCES SAY — passages ranked against this assignment, "
                     "each from a different piece:")
        for i, p in enumerate(pack["passages"], 1):
            lines.append("[%d] %s (%s%s)" % (i, p["title"], p["host"],
                                              (", " + p["publishedAt"]) if p["publishedAt"] else ""))
            lines.append(p["text"])
            lines.append("")
    if pack["cards"]:
        lines.append("THE WIDER FIELD — summaries and key points of related pieces "
                     "(breadth and framing, not verified fact):")
        for c in pack["cards"]:
            kp = "; ".join(c["keyPoints"])
            lines.append("- %s (%s%s, %s): %s%s" % (
                c["title"], c["host"], (", " + c["publishedAt"]) if c["publishedAt"] else "",
                c["category"] or "uncategorised", c["summary"], (" Key points: " + kp) if kp else ""))
    return "\n".join(lines)


def outline(markdown):
    return [("  " * (len(m.group(1)) - 1)) + m.group(2)[:90] for m in HEADING.finditer(markdown)][:14]


def preview(markdown):
    body = "\n".join(l for l in markdown.splitlines() if not l.startswith("# ")).strip()
    return body[:PREVIEW_CHARS].rsplit(" ", 1)[0] if len(body) > PREVIEW_CHARS else body


# ---- main -----------------------------------------------------------------------------------

def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"kind": "write-prep", "ts": ts, "drafted": 0}

    tasks = [t for t in rows("p-scout-article-tasks") if t.get("status") == "accepted" and t.get("taskId")]
    drafts = rows("p-scout-drafts")
    done = {d.get("taskId") for d in drafts}
    out["acceptedTasks"] = len(tasks)
    out["alreadyDrafted"] = len([t for t in tasks if t["taskId"] in done])
    if WRITER_MODEL:
        out["writerModel"] = WRITER_MODEL
    if TASK_ID:
        # Explicitly requested from the app: draft it even if a draft exists — a second opinion
        # from a different model is exactly why someone presses that button.
        task = next((t for t in tasks if t["taskId"] == TASK_ID), None)
        if not task:
            out["error"] = "no accepted task with taskId %r" % TASK_ID
            print(json.dumps(out)); return
        out["requestedTaskId"] = TASK_ID
    else:
        eligible = sorted((t for t in tasks if t["taskId"] not in done),
                          key=lambda t: str(t.get("createdAt") or ""))
        if not eligible:
            print(json.dumps(out)); return
        task = eligible[0]

    findings = []
    for place in FINDING_PLACES:
        for f in rows(place):
            f["_recency"] = place.replace("p-find-", "")
            findings.append(f)
    brief = (rows("p-scout-brief") or [{}])[0]
    pack = knowledge_pack(task, findings, brief)
    evidence = pack_text(task, pack)

    # The owner's related articles, so the draft can link them instead of repeating them.
    host = host_of(task.get("competitorUrl", ""))
    want = terms(task.get("title", ""), host) | terms(task.get("rationale", ""), host)
    related = []
    for o in rows("p-scout-owned"):
        try:
            ot = set(json.loads(o.get("terms") or "[]"))
        except Exception:
            ot = terms(o.get("slug", ""))
        if not ot or not want:
            continue
        j = len(want & ot) / len(want | ot)
        if j > 0.05:
            related.append((j, o.get("slug", "")))
    related = [s for _, s in sorted(related, reverse=True)[:RELATED_MAX]]

    claude = next((c for c in CLAUDE_CANDIDATES if c and os.path.exists(c)), None)
    if not claude:
        out["error"] = "claude binary not found on this host"
        print(json.dumps(out)); return

    # The pack is the audit trail of what the writer saw; store it before writing anything.
    knowledge_urn = ""
    try:
        knowledge_urn = put_blob("KNOWLEDGE PACK\nTASK: %s\nTITLE: %s\nBUILT: %s\nSOURCES: %d\nHOSTS: %s\n\n%s"
                                 % (task["taskId"], task.get("title", ""), ts, pack["sourcesUsed"],
                                    ", ".join(pack["hosts"]), evidence))["urn"]
    except Exception as e:
        out["knowledgeBlobError"] = str(e)[:120]

    links = ("RELATED ARTICLES ALREADY ON THE OWNER'S SITE — link them with relative paths like "
             "/slug/ where they genuinely help the reader; never repeat their content: "
             + ", ".join(related)) if related else ""
    prompt = """You are the staff writer for this investigation. Write ONE publish-ready article.

TOPIC: %s
%s

THE ASSIGNMENT
title: %s
why it was accepted: %s
category: %s

EVIDENCE — %d sources across %d sites. Synthesise across them: where they agree, say it once
and well; where they disagree or leave something out, say so and take a position. Nothing
below is verified fact — keep a concrete value only when a source states it or it is common
knowledge, and never cite these sources by URL inside the article.

%s

%s

Write 1100-1500 words of practical markdown:
- Open with the reader's actual problem, not a definition.
- Deliver what the rationale says the competitor stops short of — that is the whole point.
- Structure with ## and ### headings; use tables or numbered steps where they beat prose.
- Concrete values over vague advice. Plain language. No filler intros, no 'in conclusion'.
- Do NOT copy or closely paraphrase any source's sentences; write from understanding.
- End with a short FAQ (3 questions) if the topic invites one.

Output ONLY the article markdown, starting directly with the first line of the article.
No preamble, no code fences around the whole article, no commentary.""" % (
        brief.get("topic", ""), brief.get("domainHint", ""), task.get("title", ""),
        task.get("rationale", ""), task.get("gapCategory", ""),
        pack["sourcesUsed"], len(pack["hosts"]), evidence, links)

    cmd = [claude, "-p", prompt, "--allowedTools", "", "--no-session-persistence"]
    if WRITER_MODEL:
        cmd += ["--model", WRITER_MODEL]
    try:
        run = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True,
                             text=True, timeout=CLAUDE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        out["error"] = "claude timed out after %ss" % CLAUDE_TIMEOUT_S
        print(json.dumps(out)); return
    draft = (run.stdout or "").strip()
    if run.returncode != 0 or len(draft) < 400:
        out["error"] = ("claude rc=%s stderr=%s stdoutChars=%s"
                        % (run.returncode, (run.stderr or "")[:160], len(draft)))
        print(json.dumps(out)); return

    # The blob is the article. The token only describes it: the dashboard reads the blob when
    # someone opens the draft, so nothing article-sized ever sits in a place.
    blob_urn = ""
    try:
        blob_urn = put_blob("TITLE: %s\nTASK: %s\nWRITER: claude-code %s\nWRITTEN: %s\nKNOWLEDGE: %s\n\n%s"
                            % (task.get("title", ""), task["taskId"],
                               WRITER_MODEL or "default", ts, knowledge_urn, draft))["urn"]
    except Exception as e:
        out["blobError"] = str(e)[:120]
    if not blob_urn:
        out["error"] = "article written but the blobstore refused it; nothing filed"
        print(json.dumps(out)); return

    writer = ("claude-code:" + WRITER_MODEL) if WRITER_MODEL else "claude-code"
    revision = len([d for d in drafts if d.get("taskId") == task["taskId"]]) + 1
    token = {
        "kind": "draft", "source": writer, "writerModel": WRITER_MODEL or "default",
        "ts": ts, "status": "draft",
        "taskId": task["taskId"], "title": task.get("title", ""),
        "gapCategory": task.get("gapCategory", ""),
        "competitorUrl": task.get("competitorUrl", ""),
        "briefId": brief.get("briefId", ""),
        "wordCount": str(len(draft.split())),
        "revision": str(revision),
        "blobUrn": blob_urn,
        "knowledgeBlobUrn": knowledge_urn,
        "sourcesUsed": str(pack["sourcesUsed"]),
        "sourceHosts": json.dumps(pack["hosts"]),
        "relatedOwnSlugs": json.dumps(related),
        "preview": preview(draft),
        "outline": json.dumps(outline(draft)),
    }
    # Revision 1 keeps the historic name so nothing that looked it up by name breaks; later
    # drafts of the same task must NOT collide with it.
    name = ("draft-" + task["taskId"] if revision == 1 else
            "draft-%s-%s-r%d" % (task["taskId"], (WRITER_MODEL or "default"), revision))
    try:
        api("POST", "/api/runtime/places/p-scout-drafts/tokens?modelId=" + MODEL,
            {"name": name, "data": token})
        out.update(drafted=1, taskId=task["taskId"], wordCount=token["wordCount"],
                   revision=revision, blobUrn=blob_urn, knowledgeBlobUrn=knowledge_urn,
                   sourcesUsed=pack["sourcesUsed"], sourceHosts=len(pack["hosts"]),
                   competitorChars=len(pack["competitor"]),
                   passageChars=sum(len(p["text"]) for p in pack["passages"]),
                   cards=len(pack["cards"]), relatedOwn=len(related))
    except Exception as e:
        out["error"] = str(e)[:200]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
