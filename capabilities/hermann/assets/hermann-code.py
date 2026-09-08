#!/usr/bin/env python3
"""hermann-code: implement an approved spec with a spawned Claude Code instance, inside the contract.

usage:
  hermann-code.py code <specId>        branch from main, implement, verify, commit, push, open the PR
  hermann-code.py revise <runId>       continue on the run's branch with the review points and the person's notes
The coder works only inside the repository, with least-privilege tools, from a brief made of the
goal, the principles, the accepted decisions, the spec and the twelve factor practices. This script
(not the coder) runs the authoritative `./mvnw verify`, commits, pushes and opens the pull request,
then queues verification. A failed build still ships the branch so nothing is lost; the run says so.
"""
import glob
import json
import os
import re
import sys
import time

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
    body = {"data": data}
    if name:
        body["name"] = name
    return api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (place, MODEL), body)


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

LANE = "t-hermann-code-cmd"
DEFAULT_TOOLS = "Read,Grep,Glob,Edit,Write,MultiEdit,Bash(./mvnw:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(ls:*),Bash(cat:*),Bash(find:*),Bash(mkdir:*)"


def spec_by_id(spec_id):
    s = one(P["specs"], 'FROM $ WHERE $.specId == "%s" LIMIT 1' % spec_id)
    if not s:
        raise RuntimeError("spec %s not found" % spec_id)
    return s


def run_by_id(run_id):
    r = one(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id)
    if not r:
        raise RuntimeError("run %s not found" % run_id)
    return r


def render_spec(s):
    def block(title, items):
        items = as_list(items)
        return "\n### %s\n%s\n" % (title, "\n".join("- " + str(i) for i in items) if items else "- none")
    txt = "# %s: %s\n\n%s\n\n## Story\n%s\n" % (s.get("specId"), s.get("title"), s.get("summary", ""), s.get("story", ""))
    txt += block("Acceptance criteria", s.get("acceptance"))
    txt += block("API", s.get("api"))
    txt += block("Data", s.get("data"))
    cfg = []
    for c in as_list(s.get("config")):
        c = as_dict(c) if not isinstance(c, dict) else c
        cfg.append("%s: %s (default %s)" % (c.get("name", "?"), c.get("purpose", ""), c.get("default", "")) if isinstance(c, dict) else str(c))
    txt += block("Configuration (environment variables)", cfg)
    txt += block("Tests", s.get("tests"))
    txt += block("Twelve-factor factors touched", s.get("factors"))
    txt += block("Out of scope", s.get("outOfScope"))
    txt += block("Risks", s.get("risks"))
    return txt


def build_prompt(s, rp, extra_sections):
    g = latest(P["goal"], "updatedAt") or one(P["goal"])
    accepted_adrs = adrs("accepted")
    cards = [t.get("data") or {} for t in query(P["cards"], "FROM $", 20)]
    cards.sort(key=lambda c: str(c.get("factor", "")))
    parts = [
        "You are Hermann, a twelve-factor Spring Boot developer. You are inside the repository %s (Spring Boot %s, Java %s) on a feature branch. Implement the spec below, nothing else." % (
            rp.get("repoId"), rp.get("bootVersion"), rp.get("javaVersion")),
        "## Goal\n%s\n%s" % (g.get("title", ""), g.get("description", "")),
        "## Principles\n" + "\n".join("- " + p for p in as_list(g.get("principles"))),
        "## Accepted architecture decisions\n" + ("\n".join("- %s: %s" % (a.get("title"), a.get("decision")) for a in accepted_adrs) or "- none yet"),
        "## The spec\n" + render_spec(s),
        "## Twelve-factor practice you must keep\n" + "\n".join("- %s: %s" % (c.get("title"), c.get("practice")) for c in cards),
        "## Rules\n"
        "- Work only inside this repository. Keep the change minimal and complete: every acceptance criterion gets a test.\n"
        "- Configuration values come from environment variables bound in application.yml with ${NAME:default}; never a literal credential or hostname.\n"
        "- Schema changes are new versioned Flyway migrations under src/main/resources/db/migration (never edit an applied one).\n"
        "- Do not touch Dockerfile, compose.yaml, bin/ or the logging setup unless the spec says so.\n"
        "- Run ./mvnw -q -B verify until it is green (Testcontainers needs Docker, which is available). Fix what you broke.\n"
        "- Do NOT commit or push; Hermann's pipeline commits, pushes and opens the pull request.\n"
        "- Finish with ONE line exactly in this form, then stop:\n"
        "HERMANN_RESULT: {\"summary\": \"<what you built in two sentences>\", \"filesChanged\": [\"path\", ...], \"testsAdded\": [\"ClassName#method\", ...], \"notes\": \"<anything the reviewer must know, or empty>\"}",
    ]
    parts.extend(extra_sections)
    return "\n\n".join(parts)


def surefire_counts(root):
    tests = fails = errors = 0
    for f in glob.glob(os.path.join(root, "target", "surefire-reports", "*.txt")):
        m = re.search(r"Tests run: (\d+), Failures: (\d+), Errors: (\d+)", read_text(f, 20000))
        if m:
            tests += int(m.group(1)); fails += int(m.group(2)); errors += int(m.group(3))
    return tests, fails + errors


def run_coder(prompt, root, cfg, timeout_s):
    model = str(cfg.get("claudeModel") or "sonnet")
    tools = str(cfg.get("claudeAllowedTools") or DEFAULT_TOOLS)
    max_turns = str(as_int(cfg.get("claudeMaxTurns"), 80))
    cmd = ["claude", "-p", "--model", model, "--allowedTools", tools, "--max-turns", max_turns, "--no-session-persistence", "--output-format", "json"]
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    env["GITEA_TOKEN"] = ""  # the coder never sees the git host token
    started = time.time()
    rc, o, e = run(cmd, cwd=root, timeout=timeout_s, env=env, check=False, input_text=prompt)
    duration = round(time.time() - started)
    result_text, cost, turns, is_error = "", "", "", rc != 0
    try:
        j = json.loads(o.strip().splitlines()[-1]) if o.strip() else {}
        result_text = str(j.get("result", ""))
        cost = str(j.get("total_cost_usd", ""))
        turns = str(j.get("num_turns", ""))
        is_error = bool(j.get("is_error", False)) or rc != 0
    except (ValueError, IndexError):
        result_text = (o or e)[-3000:]
    summary = {"summary": "", "filesChanged": [], "testsAdded": [], "notes": ""}
    m = re.search(r"HERMANN_RESULT:\s*(\{.*\})", result_text, re.S)
    if m:
        try:
            summary.update(json.loads(m.group(1)))
        except ValueError:
            summary["notes"] = "result line was not valid JSON"
    if not summary.get("summary"):
        summary["summary"] = result_text[-800:].strip()
    return {"rc": rc, "isError": is_error, "durationSec": duration, "costUsd": cost, "turns": turns, "summary": summary, "stderr": (e or "")[-1500:]}


def record_run(data):
    for t in query(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 5' % data["runId"], 5):
        delete_token(P["runs"], t["id"])
    put_token(P["runs"], data, name="run-%s" % data["runId"])


def implement(spec_id=None, run_id=None):
    cfg = config()
    rp = repo()
    if not rp or rp.get("status") != "bootstrapped":
        raise RuntimeError("no bootstrapped repository")
    root = rp["localPath"]
    previous = run_by_id(run_id) if run_id else None
    s = spec_by_id(previous["specId"] if previous else spec_id)
    spec_id = s["specId"]
    attempt = as_int((previous or {}).get("attempt"), 0) + 1
    run_id = run_id or "run-%s-%s" % (spec_id, now().replace(":", "").replace("-", "")[:15])
    branch = (previous or {}).get("branch") or "feat/%s" % spec_id
    git(["fetch", "-q", "origin"], cwd=root)
    if previous:
        git(["checkout", "-q", "-B", branch, "origin/%s" % branch], cwd=root)
    else:
        git(["checkout", "-q", "-B", branch, "origin/%s" % rp.get("defaultBranch", "main")], cwd=root)
    spec_path = os.path.join(root, "docs", "specs", "%s.md" % spec_id)
    os.makedirs(os.path.dirname(spec_path), exist_ok=True)
    with open(spec_path, "w", encoding="utf-8") as f:
        f.write(render_spec(s))
    extra = []
    notes = envv("DECISION_NOTES")
    if notes:
        extra.append("## Notes from the person who approved this\n" + notes[:2000])
    if previous:
        review = latest(P["reviews"], "at", 'FROM $ WHERE $.runId == "%s"' % run_id)
        ver = latest(P["verification"], "at", 'FROM $ WHERE $.runId == "%s"' % run_id)
        extra.append("## This is attempt %d on the same branch. Address these review points\n%s" % (
            attempt, "\n".join("- %s" % (json.dumps(p) if isinstance(p, dict) else p) for p in as_list(review.get("points"))) or "- (no review points)"))
        if previous.get("status") == "failed":
            extra.append("## The previous attempt failed to build or test\n" + str(previous.get("buildTail", ""))[:2500])
        if ver and ver.get("status") == "fail":
            extra.append("## Verification failed\n" + "\n".join("- " + str(x) for x in as_list(ver.get("evidence"))))
    prompt = build_prompt(s, rp, extra)
    journal(LANE, "code", "coder starts on %s (%s, attempt %d, branch %s)" % (spec_id, s.get("title", "")[:80], attempt, branch), specId=spec_id, runId=run_id)
    started = now()
    coder = run_coder(prompt, root, cfg, as_int(cfg.get("implementTimeoutMin"), 45) * 60)
    rc, o, e = run(["./mvnw", "-q", "-B", "verify"], cwd=root, timeout=1500, check=False)
    tests, failed = surefire_counts(root)
    build_ok = rc == 0
    rc2, status_out, _ = run(["git", "status", "--porcelain"], cwd=root, check=False)
    changed = [l[3:] for l in status_out.splitlines() if l.strip()]
    git(["add", "-A"], cwd=root)
    rc3, _, _ = git(["commit", "-q", "-m", "%s(%s): %s\n\n%s" % ("feat" if attempt == 1 else "fix", spec_id, str(s.get("title", ""))[:72], str(coder["summary"].get("summary", ""))[:800])], cwd=root, check=False)
    git(["push", "-q", "-u", "origin", branch], cwd=root, timeout=600)
    sha = head_sha(root)
    rc4, stat, _ = run(["git", "diff", "--shortstat", "origin/%s...HEAD" % rp.get("defaultBranch", "main")], cwd=root, check=False)
    pr_index, pr_url = (previous or {}).get("prIndex", ""), (previous or {}).get("prUrl", "")
    if not pr_index:
        body = "%s\n\n## Coder summary\n%s\n\n## Verification\n`./mvnw verify` %s: %d tests, %d failed\n" % (
            render_spec(s), coder["summary"].get("summary", ""), "green" if build_ok else "RED", tests, failed)
        body_file = os.path.join(hermann_home(cfg), ".pr-body-%s.md" % run_id)
        with open(body_file, "w", encoding="utf-8") as f:
            f.write(body)
        st, pr = gitea("POST", "/repos/%s/%s/pulls" % (rp.get("owner", "hermann"), rp["repoId"]), {"head": branch, "base": rp.get("defaultBranch", "main"), "title": "%s: %s" % (spec_id, str(s.get("title", ""))[:200]), "body": body[:60000]})
        if st in (200, 201):
            pr_index, pr_url = str(pr.get("number")), pr.get("html_url", "")
        else:
            journal(LANE, "code", "pull request could not be opened (%s): %s" % (st, str(pr)[:200]), runId=run_id)
        try:
            os.remove(body_file)
        except OSError:
            pass
    data = {
        "at": now(), "startedAt": started, "runId": run_id, "specId": spec_id, "iterationId": s.get("iterationId", ""), "attempt": str(attempt),
        "branch": branch, "headSha": sha, "prIndex": pr_index, "prUrl": pr_url, "filesChanged": changed[:60], "diffStat": stat.strip(),
        "testsRun": str(tests), "testsFailed": str(failed), "buildOk": str(build_ok).lower(),
        "buildTail": "" if build_ok else (e or o)[-2500:],
        "coderSummary": str(coder["summary"].get("summary", ""))[:1200], "coderNotes": str(coder["summary"].get("notes", ""))[:800],
        "coderTestsAdded": as_list(coder["summary"].get("testsAdded")), "coderTurns": coder["turns"], "coderCostUsd": coder["costUsd"],
        "coderDurationSec": str(coder["durationSec"]), "coderError": str(coder["isError"]).lower(),
        "status": "pr-open" if build_ok else "failed", "title": s.get("title", ""),
    }
    record_run(data)
    if build_ok:
        put_token(P["verify_cmd"], command_token("hermann-verify", ["verify", run_id], stage="verify", timeout_ms=2400000, runId=run_id, specId=spec_id), name="verify-%s" % run_id)
    journal(LANE, "code", "%s attempt %d: %d files, %d tests (%d failed), build %s, PR %s, coder %ss/%s turns" % (
        spec_id, attempt, len(changed), tests, failed, "green" if build_ok else "RED", pr_url or "not opened", coder["durationSec"], coder["turns"] or "?"),
        runId=run_id, specId=spec_id, status=data["status"])
    return {"success": build_ok, "runId": run_id, "branch": branch, "pr": pr_url, "tests": tests, "failed": failed, "files": len(changed), "coderSec": coder["durationSec"]}


def main(argv):
    if len(argv) >= 2 and argv[0] == "code":
        return implement(spec_id=argv[1])
    if len(argv) >= 2 and argv[0] == "revise":
        return implement(run_id=argv[1])
    raise RuntimeError("usage: hermann-code.py code <specId> | revise <runId>")


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
