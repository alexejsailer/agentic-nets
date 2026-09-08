#!/usr/bin/env python3
"""hermann-context: everything a judgement lane needs, measured and rendered once.

usage:
  hermann-context.py context propose <iterationId>              brief for the next-iteration proposal
  hermann-context.py context spec <iterationId> <promptId>      brief for writing the spec from the answer
                                                                 (RESPONSE_SELECTED / RESPONSE_TEXT / RESPONSE_NOTES in env)
Writes ONE p-hermann-context token with `purpose` and a `brief` (markdown, under 14 KB) that the
agent lane pastes into its prompt. The LLM never reads the repository or the model; it reads this.
"""
import json
import os
import sys

# >>> shared: hermannlib (generated, do not edit here)
"""Shared library for the Hermann scripts. Inlined into every hermann-*.py by
tools/inline-shared.py (the executor runs each script as ONE file). Edit here, then re-inline.

Everything a lane measures is written back to the model through master (X-Service-Auth when the
internal service token is set). Secrets never enter a token: the git host token is injected into
the lanes' environment from the vault as GITEA_TOKEN.
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "hermann")
SERVICE_TOKEN = os.environ.get("AGENTICOS_SERVICE_TOKEN", "").strip()
HERMANN_HOME = os.path.expanduser(os.environ.get("HERMANN_HOME", "~/hermann"))

P = {
    "config": "p-hermann-config",
    "infra": "p-hermann-infra",
    "repo": "p-hermann-repo",
    "journal": "p-hermann-journal",
    "errors": "p-hermann-errors",
    "audit_req": "p-hermann-audit-request",
    "audit_cmd": "p-hermann-audit-cmd",
    "factor_cmd": "p-hermann-factor-cmd",
    "digest": "p-hermann-repo-digest",
    "reports": "p-hermann-factor-reports",
    "scorecard": "p-hermann-scorecard",
    "cards": "p-hermann-cards",
    "coders": "p-hermann-coders",
    "goal": "p-hermann-goal",
    "adr": "p-hermann-adr",
    "prompts": "p-hermann-prompts",
    "responses": "p-hermann-responses",
    "specs": "p-hermann-specs",
    "work": "p-hermann-work-queue",
    "runs": "p-hermann-runs",
    "verification": "p-hermann-verification",
    "reviews": "p-hermann-reviews",
    "decisions": "p-hermann-decisions",
    "risks": "p-hermann-risks",
    "upgrades": "p-hermann-upgrades",
    "context": "p-hermann-context",
    "iterate": "p-hermann-iterate",
    "context_cmd": "p-hermann-context-cmd",
    "code_cmd": "p-hermann-code-cmd",
    "verify_cmd": "p-hermann-verify-cmd",
    "review_cmd": "p-hermann-review-cmd",
    "release_cmd": "p-hermann-release-cmd",
    "llm_errors": "p-hermann-llm-errors",
}


def envv(name, default=""):
    """An environment value set by a map-lane template; an unresolved `${...}` placeholder counts as unset."""
    v = os.environ.get(name, "")
    if v is None or v.strip().startswith("${"):
        return default
    return v.strip() or default

FACTORS = [
    ("01", "codebase", "Codebase", "One codebase tracked in revision control, many deploys"),
    ("02", "dependencies", "Dependencies", "Explicitly declare and isolate dependencies"),
    ("03", "config", "Config", "Store config in the environment"),
    ("04", "backing-services", "Backing services", "Treat backing services as attached resources"),
    ("05", "build-release-run", "Build, release, run", "Strictly separate build and run stages"),
    ("06", "processes", "Processes", "Execute the app as one or more stateless processes"),
    ("07", "port-binding", "Port binding", "Export services via port binding"),
    ("08", "concurrency", "Concurrency", "Scale out via the process model"),
    ("09", "disposability", "Disposability", "Maximize robustness with fast startup and graceful shutdown"),
    ("10", "dev-prod-parity", "Dev/prod parity", "Keep development, staging, and production as similar as possible"),
    ("11", "logs", "Logs", "Treat logs as event streams"),
    ("12", "admin-processes", "Admin processes", "Run admin/management tasks as one-off processes"),
]


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def log(msg):
    print(str(msg), file=sys.stderr, flush=True)


def out(obj):
    print(json.dumps(obj, sort_keys=True), flush=True)


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if SERVICE_TOKEN:
        req.add_header("X-Service-Auth", "Bearer " + SERVICE_TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("%s %s -> HTTP %s: %s" % (method, path, e.code, detail))


def put_token(place, data, name=None):
    """Append a token. A token NAME must be unique within its place (the node answers 500 to a
    duplicate), so a named write that is refused is retried once with a timestamp suffix."""
    body = {"data": data}
    if name:
        body["name"] = name
    try:
        return api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (place, MODEL), body)
    except RuntimeError as e:
        if name and "HTTP 500" in str(e):
            body["name"] = "%s-%s" % (name, now().replace(":", "").replace("-", ""))
            return api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (place, MODEL), body)
        raise


def decode(data):
    """Nested structures round-trip through the platform as JSON text: a list or object written into a
    token comes back as a string. Decode every value that looks like one, recursively."""
    if isinstance(data, dict):
        return {k: decode(v) for k, v in data.items()}
    if isinstance(data, list):
        return [decode(v) for v in data]
    if isinstance(data, str):
        s = data.strip()
        if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
            try:
                return decode(json.loads(s))
            except ValueError:
                return data
    return data


def query(place, arcql="FROM $", limit=200):
    r = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL), {"arcql": arcql, "limit": limit})
    tokens = r.get("tokens", []) if isinstance(r, dict) else []
    for t in tokens:
        if isinstance(t.get("data"), dict):
            t["data"] = decode(t["data"])
    return tokens


def delete_token(place, token_id):
    api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (place, token_id, MODEL))


def one(place, arcql="FROM $ LIMIT 1"):
    t = query(place, arcql, 1)
    return (t[0].get("data") or {}) if t else {}


def latest(place, field="at", arcql="FROM $"):
    tokens = query(place, arcql, 500)
    tokens.sort(key=lambda t: str((t.get("data") or {}).get(field, "")), reverse=True)
    return (tokens[0].get("data") or {}) if tokens else {}


def keep_last(place, field="at", n=20, arcql="FROM $"):
    """Bound a measurement place: keep the newest n tokens by `field`, delete the rest."""
    tokens = query(place, arcql, 1000)
    tokens.sort(key=lambda t: str((t.get("data") or {}).get(field, "")), reverse=True)
    for t in tokens[n:]:
        try:
            delete_token(place, t["id"])
        except Exception as e:  # noqa: BLE001
            log("keep_last: %s" % e)


def journal(lane, stage, summary, **extra):
    data = {"at": now(), "lane": lane, "stage": stage, "summary": str(summary)[:600]}
    data.update({k: v for k, v in extra.items() if v is not None})
    try:
        put_token(P["journal"], data)
    except Exception as e:  # noqa: BLE001
        log("journal failed: %s" % e)


def error(lane, stage, message, **extra):
    log("ERROR %s/%s: %s" % (lane, stage, message))
    data = {"at": now(), "lane": lane, "stage": stage, "message": str(message)[:1500]}
    data.update({k: v for k, v in extra.items() if v is not None})
    try:
        put_token(P["errors"], data)
    except Exception as e:  # noqa: BLE001
        log("error token failed: %s" % e)


def run(cmd, cwd=None, timeout=600, env=None, check=False, input_text=None):
    e = dict(os.environ)
    e.update(env or {})
    shell = isinstance(cmd, str)
    p = subprocess.run(cmd, cwd=cwd, shell=shell, capture_output=True, text=True, timeout=timeout, env=e, input=input_text)
    if check and p.returncode != 0:
        raise RuntimeError("command failed (%s): %s\n%s" % (p.returncode, cmd if shell else " ".join(cmd), (p.stderr or p.stdout)[-1500:]))
    return p.returncode, p.stdout, p.stderr


def which(name):
    return shutil.which(name) or ""


def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    s = str(v).strip()
    if not s:
        return []
    if s.startswith("["):
        try:
            return [str(x) for x in json.loads(s)]
        except ValueError:
            pass
    return [x.strip() for x in s.split(",") if x.strip()]


def as_int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def as_dict(v):
    if isinstance(v, dict):
        return v
    if isinstance(v, str) and v.strip().startswith("{"):
        try:
            return json.loads(v)
        except ValueError:
            return {}
    return {}


def config():
    """The newest config token wins (the application appends a new one on every save)."""
    return latest(P["config"], "updatedAt", 'FROM $ WHERE $.configId == "hermann"') or latest(P["config"], "updatedAt")


def adrs(status=None):
    """Architecture decision records, one per adrId (the newest token for each id wins)."""
    by_id = {}
    for t in query(P["adr"], "FROM $", 300):
        d = t.get("data") or {}
        key = d.get("adrId") or t.get("id")
        if key not in by_id or str(d.get("updatedAt", "")) >= str(by_id[key].get("updatedAt", "")):
            by_id[key] = d
    rows = sorted(by_id.values(), key=lambda a: str(a.get("adrId", "")))
    return [a for a in rows if status is None or a.get("status") == status]


def repo(name=None):
    if name:
        return one(P["repo"], 'FROM $ WHERE $.repoId == "%s" LIMIT 1' % name)
    return latest(P["repo"], "updatedAt")


def infra():
    return latest(P["infra"], "at")


def hermann_home(cfg=None):
    home = os.path.expanduser(str((cfg or {}).get("hermannHome") or HERMANN_HOME))
    os.makedirs(home, exist_ok=True)
    return home


def gitea_url(cfg=None):
    inf = infra()
    if inf.get("giteaUrl"):
        return str(inf["giteaUrl"]).rstrip("/")
    cfg = cfg or config()
    return "http://127.0.0.1:%s" % cfg.get("giteaPort", "3300")


def gitea(method, path, body=None, token=None, timeout=30, base=None):
    """Gitea REST call. Returns (status, json|text). The token comes from the lane's environment."""
    token = token or os.environ.get("GITEA_TOKEN", "").strip()
    url = (base or gitea_url()) + "/api/v1" + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token and token != "-":  # "-" = deliberately anonymous (Gitea rejects any invalid token, even on public routes)
        req.add_header("Authorization", "token " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, (json.loads(raw) if raw.strip() else {})
            except ValueError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw
    except Exception as e:  # noqa: BLE001  (connection refused/reset while the host starts, timeouts)
        return 0, "%s: %s" % (type(e).__name__, e)


def git(args, cwd, timeout=300, check=True):
    """git with the vault-injected token supplied through a credential helper: the secret is read
    from the environment by the helper, never placed in argv, the remote URL, or .git/config."""
    helper = "!f() { echo username=${GITEA_USER:-hermann}; echo password=$GITEA_TOKEN; }; f"
    cmd = ["git", "-c", "credential.helper=" + helper, "-c", "user.name=Hermann", "-c", "user.email=hermann@localhost"] + list(args)
    return run(cmd, cwd=cwd, timeout=timeout, check=check)


def ensure_repo(name, cfg=None):
    """The repository on the git host: existing one returned, otherwise created. (body, created)."""
    cfg = cfg or config()
    user = cfg.get("giteaUser", "hermann")
    st, body = gitea("GET", "/repos/%s/%s" % (user, name))
    if st == 200:
        return body, False
    st, body = gitea("POST", "/user/repos", {
        "name": name, "description": str(cfg.get("description") or "Built by Hermann, the twelve-factor Spring Boot developer")[:255],
        "private": False, "default_branch": "main", "auto_init": False, "trust_model": "default",
    })
    if st not in (200, 201):
        raise RuntimeError("repo creation failed (%s): %s" % (st, str(body)[:300]))
    return body, True


def record_repo(name, body, cfg, status, **extra):
    """Replace the p-hermann-repo record for `name` (one token per repository)."""
    home = hermann_home(cfg)
    old = query(P["repo"], 'FROM $ WHERE $.repoId == "%s" LIMIT 10' % name, 10)
    previous = (old[0].get("data") or {}) if old else {}
    data = dict(previous)
    data.update({
        "repoId": name, "name": name, "owner": (body.get("owner") or {}).get("login", cfg.get("giteaUser", "hermann")),
        "htmlUrl": body.get("html_url", ""), "cloneUrl": body.get("clone_url", ""), "sshUrl": body.get("ssh_url", ""),
        "localPath": os.path.join(home, name), "defaultBranch": body.get("default_branch", "main") or "main",
        "status": status, "updatedAt": now(),
    })
    data.setdefault("createdAt", data["updatedAt"])
    data.update(extra)
    for t in old:
        delete_token(P["repo"], t["id"])
    put_token(P["repo"], data, name="repo-%s" % name)
    return data


def protect_main(name, cfg=None):
    """No direct pushes to main; changes arrive through pull requests. (status, body)."""
    cfg = cfg or config()
    owner = cfg.get("giteaUser", "hermann")
    return gitea("POST", "/repos/%s/%s/branch_protections" % (owner, name), {
        "branch_name": "main", "rule_name": "main", "enable_push": False, "enable_push_whitelist": False,
        "required_approvals": 0, "block_on_rejected_reviews": True, "enable_status_check": False,
        "block_on_outdated_branch": False, "dismiss_stale_approvals": False,
    })


def head_sha(path):
    rc, o, _ = run(["git", "rev-parse", "HEAD"], cwd=path, check=False)
    return o.strip() if rc == 0 else ""


def read_text(path, limit=6000):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            s = f.read(limit + 1)
        return s[:limit]
    except OSError:
        return ""


def walk_files(root, exts=None, skip=("target", ".git", "node_modules", ".mvn", ".idea")):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in filenames:
            if exts is None or any(fn.endswith(x) for x in exts):
                found.append(os.path.join(dirpath, fn))
    return found


def command_token(tool_id, argv, stage=None, timeout_ms=600000, **extra):
    """A script-by-reference command token in the shape the executor runs."""
    tok = {
        "kind": "command", "id": "%s-%s" % (tool_id, now().replace(":", "").replace("-", "")),
        "executor": "script", "command": "invoke", "expect": "text",
        "args": {"toolId": tool_id, "argv": [str(a) for a in argv], "env": {"MODEL_ID": MODEL}, "timeoutMs": timeout_ms},
        "filedAt": now(),
    }
    if stage:
        tok["stage"] = stage
    tok.update(extra)
    return tok


def main_guard(lane, fn, argv):
    """Run a script entry point; on failure write an error token and exit non-zero."""
    try:
        result = fn(argv)
        if result is not None:
            out(result)
        return 0
    except Exception as e:  # noqa: BLE001
        error(lane, argv[0] if argv else "main", "%s: %s" % (type(e).__name__, e), argv=argv)
        out({"success": False, "error": str(e)[:800]})
        return 1
# <<< shared: hermannlib

LANE = "t-hermann-context-cmd"
PLACEHOLDER = "REPLACE ME"


def lines(items, limit=12, prefix="- "):
    out_lines = []
    for it in items[:limit]:
        out_lines.append(prefix + str(it))
    return "\n".join(out_lines) if out_lines else "- (none)"


def goal_section():
    g = latest(P["goal"], "updatedAt") or one(P["goal"])
    undefined = not g or PLACEHOLDER in str(g.get("title", "")).upper() or PLACEHOLDER in str(g.get("description", "")).upper()
    txt = "## GOAL\n"
    if undefined:
        txt += "The goal is NOT DEFINED yet (placeholder). Nothing can be specified before the person defines it.\n"
    else:
        txt += "%s\n%s\n" % (g.get("title", ""), g.get("description", ""))
    txt += "\n## PRINCIPLES\n%s\n" % lines(as_list(g.get("principles")))
    cons = as_list(g.get("constraints"))
    if cons:
        txt += "\n## CONSTRAINTS\n%s\n" % lines(cons)
    return txt, ("undefined" if undefined else "defined"), g


def adr_section():
    rows = adrs()
    accepted = [a for a in rows if a.get("status") == "accepted"]
    proposed = [a for a in rows if a.get("status") == "proposed"]
    txt = "## ARCHITECTURE DECISIONS (accepted)\n" + lines(["%s: %s" % (a.get("adrId", "?"), (a.get("title", "") + ": " + str(a.get("decision", ""))[:240])) for a in accepted], 20)
    if proposed:
        txt += "\n\nOpen ADR proposals: " + ", ".join("%s (%s)" % (a.get("adrId"), a.get("title", "")[:60]) for a in proposed[:6])
    return txt + "\n"


def service_section():
    rp = repo()
    if not rp or rp.get("status") != "bootstrapped":
        return "## SERVICE\nNo service bootstrapped yet.\n", rp
    dg = latest(P["digest"], "at")
    pom = as_dict(dg.get("pom")) if dg else {}
    deps = [d.get("a") for d in (pom.get("dependencies") or []) if isinstance(d, dict)]
    txt = "## SERVICE\nrepository %s (%s), branch %s, head %s, Spring Boot %s, Java %s\n" % (
        rp.get("repoId"), rp.get("htmlUrl"), rp.get("defaultBranch", "main"), str(rp.get("headSha", ""))[:7], rp.get("bootVersion"), rp.get("javaVersion"))
    txt += "dependencies: %s\n" % ", ".join(d for d in deps if d)[:600]
    if dg:
        txt += "main classes: %s\n" % ", ".join(os.path.basename(p) for p in (dg.get("mainJava") or []))[:500]
        txt += "tests: %s\n" % ", ".join(os.path.basename(p) for p in (dg.get("testJava") or []))[:400]
        txt += "migrations: %s\n" % ", ".join(os.path.basename(p) for p in (dg.get("migrations") or []))[:300]
        txt += "recent commits:\n%s\n" % lines(dg.get("commits") or [], 6)
    return txt, rp


def quality_section():
    sc = latest(P["scorecard"], "at")
    if not sc:
        return "## QUALITY\nNo twelve-factor scorecard yet.\n"
    txt = "## QUALITY (twelve-factor scorecard for %s)\n%s/36 (%s%%, grade %s); failing: %s; weak: %s\n" % (
        sc.get("sha7"), sc.get("total"), sc.get("percent"), sc.get("grade"), ", ".join(as_list(sc.get("failing"))) or "none", ", ".join(as_list(sc.get("weak"))) or "none")
    for f in sc.get("factors") or []:
        f = as_dict(f) if not isinstance(f, dict) else f
        if f.get("status") in ("fail", "weak"):
            txt += "- factor %s %s scored %s/3; fix: %s\n" % (f.get("factor"), f.get("name"), f.get("score"), f.get("fix"))
    return txt


def risk_section():
    risks = [t.get("data") or {} for t in query(P["risks"], 'FROM $ WHERE $.status == "open"', 50)]
    ups = [t.get("data") or {} for t in query(P["upgrades"], 'FROM $ WHERE $.status == "open"', 50)]
    txt = "## OPEN RISKS\n" + lines(["%s [%s] %s" % (r.get("riskId", "?"), r.get("severity", "?"), str(r.get("title", ""))[:140]) for r in risks], 10)
    txt += "\n\n## UPGRADE PROPOSALS\n" + lines(["%s: %s -> %s (%s)" % (u.get("upgradeId", "?"), u.get("current", "?"), u.get("latest", "?"), str(u.get("title", ""))[:100]) for u in ups], 10)
    return txt + "\n"


def history_section(repo_id=None):
    specs = [t.get("data") or {} for t in query(P["specs"], "FROM $", 200)]
    runs = [t.get("data") or {} for t in query(P["runs"], "FROM $", 200)]
    if repo_id:
        # Specs carry the repoId Hermann copied from their brief; older ones (before repoId existed) are kept.
        specs = [x for x in specs if not x.get("repoId") or x.get("repoId") == repo_id]
        runs = [r for r in runs if not r.get("repoId") or r.get("repoId") == repo_id]
    runs.sort(key=lambda r: str(r.get("at", "")), reverse=True)
    prompts = [t.get("data") or {} for t in query(P["prompts"], "FROM $", 100)]
    txt = "## SPECS SO FAR (merged ones are DONE: never propose them again)\n" + lines([
        "%s [%s] %s%s" % (s.get("specId", "?"), s.get("status", "?"), str(s.get("title", ""))[:100],
                          (" | API: " + "; ".join(str(a)[:80] for a in as_list(s.get("api"))[:6])) if s.get("status") == "merged" else "")
        for s in specs], 25)
    txt += "\n\n## RECENT RUNS\n" + lines(["%s spec %s: %s (%s)" % (r.get("runId", "?"), r.get("specId", "?"), r.get("status", "?"), str(r.get("coderSummary", ""))[:120]) for r in runs], 5)
    txt += "\n\n## EARLIER PROPOSALS (do not repeat verbatim)\n" + lines([str(p.get("question", ""))[:120] for p in prompts[-4:]], 4)
    jr = [t.get("data") or {} for t in query(P["journal"], "FROM $", 300)]
    jr.sort(key=lambda j: str(j.get("at", "")), reverse=True)
    txt += "\n\n## JOURNAL (newest first)\n" + lines(["%s %s: %s" % (str(j.get("at", ""))[11:16], j.get("stage", ""), str(j.get("summary", ""))[:140]) for j in jr], 8)
    return txt + "\n", specs


def cards_section(only_factors=None):
    cards = [t.get("data") or {} for t in query(P["cards"], "FROM $", 20)]
    cards.sort(key=lambda c: str(c.get("factor", "")))
    txt = "## THE TWELVE FACTORS (Spring Boot practice)\n"
    for c in cards:
        if only_factors and c.get("factor") not in only_factors:
            txt += "- %s: %s\n" % (c.get("title"), c.get("tagline"))
        else:
            txt += "- %s: %s\n" % (c.get("title"), c.get("practice"))
    return txt


def propose(iteration_id):
    goal_txt, goal_status, g = goal_section()
    service_txt, rp = service_section()
    earlier = query(P["prompts"], 'FROM $ WHERE $.iterationId == "%s" LIMIT 50' % iteration_id, 50)
    prompt_id = "pr-%s-%d" % (iteration_id, len(earlier) + 1)
    brief = "\n".join([
        "# BRIEF FOR HERMANN: what should the next iteration be?",
        "iterationId: %s\npromptId to use: %s\nnow: %s" % (iteration_id, prompt_id, now()),
        goal_txt, adr_section(), service_txt, quality_section(), risk_section(), history_section((rp or {}).get("repoId"))[0], cards_section(),
    ])
    revision = envv("REVISION_TEXT")
    if revision:
        brief += "\n## THE PERSON RESHAPED THE LAST QUESTION\n%s\nAsk again, taking this into account.\n" % revision[:1500]
    data = {"at": now(), "iterationId": iteration_id, "purpose": "propose", "promptId": prompt_id, "goalStatus": goal_status,
            "repoId": (rp or {}).get("repoId", ""), "sha": (rp or {}).get("headSha", ""), "brief": brief[:14000]}
    put_token(P["context"], data, name="ctx-propose-%s" % iteration_id)
    journal(LANE, "context", "proposal brief for %s: goal %s, %d chars" % (iteration_id, goal_status, len(brief)), iterationId=iteration_id)
    return {"success": True, "iterationId": iteration_id, "goalStatus": goal_status, "chars": len(brief)}


def spec(iteration_id, prompt_id):
    goal_txt, goal_status, g = goal_section()
    if goal_status == "undefined":
        raise RuntimeError("the goal is still a placeholder; define it before specifying work")
    service_txt, rp = service_section()
    pr = one(P["prompts"], 'FROM $ WHERE $.promptId == "%s" LIMIT 1' % prompt_id)
    selected = as_list(envv("RESPONSE_SELECTED"))
    text = envv("RESPONSE_TEXT")
    notes = envv("RESPONSE_NOTES")
    chosen = []
    for o in as_list(pr.get("options")) if pr else []:
        o = as_dict(o) if not isinstance(o, dict) else o
        if str(o.get("value")) in selected:
            chosen.append("%s: %s (%s)" % (o.get("value"), o.get("label"), str(o.get("description", ""))[:400]))
    history, specs = history_section((rp or {}).get("repoId"))
    all_specs = query(P["specs"], "FROM $", 300)
    spec_id = "spec-%03d" % (len(all_specs) + 1)
    choice = "## THE DECISION THIS SPEC IMPLEMENTS\nHermann asked (%s, mode %s): %s\n" % (prompt_id, pr.get("mode", "?"), pr.get("question", "?"))
    choice += "The person chose:\n%s\n" % (lines(chosen) if chosen else "- (no option selected)")
    if text:
        choice += "The person wrote: %s\n" % text[:2000]
    if notes:
        choice += "Notes: %s\n" % notes[:1000]
    brief = "\n".join([
        "# BRIEF FOR HERMANN: write the spec",
        "iterationId: %s\npromptId: %s\nspecId to use: %s\nrepoId to use: %s\nnow: %s" % (iteration_id, prompt_id, spec_id, (rp or {}).get("repoId", ""), now()),
        choice, goal_txt, adr_section(), service_txt, quality_section(), history, cards_section(),
    ])
    data = {"at": now(), "iterationId": iteration_id, "purpose": "spec", "promptId": prompt_id, "specId": spec_id, "goalStatus": goal_status,
            "repoId": (rp or {}).get("repoId", ""), "sha": (rp or {}).get("headSha", ""), "selected": selected, "responseText": text, "brief": brief[:14000]}
    put_token(P["context"], data, name="ctx-spec-%s" % spec_id)
    journal(LANE, "context", "spec brief %s for %s from %s (%s)" % (spec_id, iteration_id, prompt_id, ", ".join(selected) or "free text"), iterationId=iteration_id)
    return {"success": True, "specId": spec_id, "chosen": selected, "chars": len(brief)}


def main(argv):
    if len(argv) < 3 or argv[0] != "context":
        raise RuntimeError("usage: hermann-context.py context propose|spec <iterationId> [<promptId>]")
    mode, iteration_id = argv[1], argv[2]
    if iteration_id.startswith("${") or not iteration_id:
        iteration_id = "it-%s" % now().replace(":", "").replace("-", "")
    if mode == "propose":
        return propose(iteration_id)
    if mode == "spec":
        prompt_id = argv[3] if len(argv) > 3 and not argv[3].startswith("${") else envv("PROMPT_ID")
        return spec(iteration_id, prompt_id)
    raise RuntimeError("unknown mode %s" % mode)


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
