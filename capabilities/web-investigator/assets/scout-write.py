#!/usr/bin/env python3
"""scout-write — draft ONE accepted article task with Claude Code.

Everything deterministic happens here: pick the oldest accepted task without a draft, pull
the competitor article's stored text (blob, or URL-fallback through the findings), find the
owner's related articles by term overlap, assemble the assignment — then invoke the local
`claude` binary headlessly (-p, no tools, no session persistence) and file its markdown as a
draft token. One draft per run bounds the spend; a run with nothing eligible exits quietly,
so the daily cron and the app's Draft-article button are both safe.

Dedupe is by the drafts ledger, never by consuming the task: the task token belongs to the
application's lifecycle (accepted -> done via complete-task) and must survive drafting.
"""
import json, os, re, shutil, subprocess
import urllib.request
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
BLOBS = os.environ.get("BLOB_URL", "http://127.0.0.1:8090").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
COMPETITOR_CHARS = 7000
RELATED_MAX = 5
CLAUDE_TIMEOUT_S = 240
# The executor may run with a minimal PATH; resolve the binary the way a user shell would.
CLAUDE_CANDIDATES = [shutil.which("claude"), os.path.expanduser("~/.local/bin/claude"),
                     os.path.expanduser("~/.claude/local/claude"),
                     "/usr/local/bin/claude", "/opt/homebrew/bin/claude"]
STOP = set("""a an the and or for to of in on with your you how what why when is are do does can
will vs best top guide review reviews com www html htm index page""".split())
SENTENCE = re.compile(r"[A-Z][^.!?]{60,}?[.!?](?:\s|$)")
TITLE_SUFFIX = re.compile(r"\s*[-|–—]\s*[^-|–—]{0,40}\.(com|net|org|co|io)\s*$", re.I)


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def rows(place, limit=500):
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL),
                  {"arcql": "FROM $ LIMIT %d" % limit, "limit": limit})
        return [(t.get("data") or {}) for t in (res.get("tokens") or [])]
    except Exception:
        return []


def terms(text, host=""):
    text = TITLE_SUFFIX.sub("", text or "")
    stop = set(STOP)
    stop.update(w for w in re.split(r"[^a-z0-9]+", (host or "").lower()) if len(w) > 2)
    return {w for w in re.split(r"[^a-z0-9]+", text.lower()) if w and w not in stop and len(w) > 2}


def article_body(text, title):
    start = 0
    key = " ".join((title or "").split()[:6])
    if key and len(key) > 12:
        i = text.rfind(key)
        if 0 <= i < len(text) * 0.6:
            start = i
    m = SENTENCE.search(text, start) or SENTENCE.search(text)
    return text[m.start():] if m else text


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


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"kind": "write-prep", "ts": ts, "drafted": 0}

    tasks = [t for t in rows("p-scout-article-tasks") if t.get("status") == "accepted" and t.get("taskId")]
    done = {d.get("taskId") for d in rows("p-scout-drafts")}
    eligible = sorted((t for t in tasks if t["taskId"] not in done),
                      key=lambda t: str(t.get("createdAt") or ""))
    out["acceptedTasks"] = len(tasks)
    out["alreadyDrafted"] = len([t for t in tasks if t["taskId"] in done])
    if not eligible:
        print(json.dumps(out)); return
    task = eligible[0]

    host = ""
    try:
        host = (task.get("competitorUrl") or "").split("/")[2].lower().replace("www.", "")
    except Exception:
        pass
    competitor = article_body(blob_text(task.get("blobUrn", "")), task.get("title", ""))
    # A task accepted from a digest recommendation carries no blobUrn; fall back to matching a
    # finding by URL so the writer still sees the competitor's actual text when it exists.
    if not competitor and task.get("competitorUrl"):
        for place in ("p-find-brand-new", "p-find-recent", "p-find-archive"):
            hit = next((f for f in rows(place) if f.get("url") == task["competitorUrl"] and f.get("blobUrn")), None)
            if hit:
                competitor = article_body(blob_text(hit["blobUrn"]), hit.get("title", ""))
                break
    competitor = competitor[:COMPETITOR_CHARS]

    # The owner's related articles, so the draft can link them instead of repeating them.
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

    brief = (rows("p-scout-brief") or [{}])[0]

    claude = next((c for c in CLAUDE_CANDIDATES if c and os.path.exists(c)), None)
    if not claude:
        out["error"] = "claude binary not found on this host"
        print(json.dumps(out)); return

    links = ("Related articles already on the owner's site — link them with relative paths "
             "like /slug/ where they genuinely help the reader; never repeat their content: "
             + ", ".join(related)) if related else ""
    prompt = """You are the staff writer for this investigation. Write ONE publish-ready article.

TOPIC: %s
%s

THE ASSIGNMENT
title: %s
why it was accepted: %s
category: %s

THE COMPETITOR PIECE THIS MUST BEAT (%s):
%s

%s

Write 1100-1500 words of practical markdown:
- Open with the reader's actual problem, not a definition.
- Deliver what the rationale says the competitor stops short of — that is the whole point.
- Structure with ## and ### headings; use tables or numbered steps where they beat prose.
- Concrete values over vague advice. Plain language. No filler intros, no 'in conclusion'.
- Do NOT copy or closely paraphrase the competitor's sentences; write from understanding.
- End with a short FAQ (3 questions) if the topic invites one.

Output ONLY the article markdown, starting directly with the first line of the article.
No preamble, no code fences around the whole article, no commentary.""" % (
        brief.get("topic", ""), brief.get("domainHint", ""), task.get("title", ""),
        task.get("rationale", ""), task.get("gapCategory", ""),
        task.get("competitorUrl", ""), competitor, links)

    try:
        run = subprocess.run(
            [claude, "-p", prompt, "--allowedTools", "", "--no-session-persistence"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        out["error"] = "claude timed out after %ss" % CLAUDE_TIMEOUT_S
        print(json.dumps(out)); return
    draft = (run.stdout or "").strip()
    if run.returncode != 0 or len(draft) < 400:
        out["error"] = ("claude rc=%s stderr=%s stdoutChars=%s"
                        % (run.returncode, (run.stderr or "")[:160], len(draft)))
        print(json.dumps(out)); return

    token = {
        "kind": "draft", "source": "claude-code", "ts": ts, "status": "draft",
        "taskId": task["taskId"], "title": task.get("title", ""),
        "gapCategory": task.get("gapCategory", ""),
        "competitorUrl": task.get("competitorUrl", ""),
        "briefId": brief.get("briefId", ""),
        "wordCount": str(len(draft.split())),
        "relatedOwnSlugs": json.dumps(related),
        "draftMarkdown": draft,
    }
    try:
        api("POST", "/api/runtime/places/p-scout-drafts/tokens?modelId=" + MODEL,
            {"name": "draft-" + task["taskId"], "data": token})
        out.update(drafted=1, taskId=task["taskId"], wordCount=token["wordCount"],
                   competitorChars=len(competitor), relatedOwn=len(related))
    except Exception as e:
        out["error"] = str(e)[:200]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
