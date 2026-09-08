#!/usr/bin/env python3
"""hermann-release: close an iteration.

usage: hermann-release.py merge <runId>
Merges the pull request (squash), pulls main, tags the merge with the spec id, marks the run and
the spec merged, requests the audit of the new main, and starts the next iteration.
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

LANE = "t-hermann-merge-cmd"


def replace_token(place, key, value, patch):
    old = query(place, 'FROM $ WHERE $.%s == "%s" LIMIT 5' % (key, value), 5)
    data = dict((old[0].get("data") or {})) if old else {}
    data.update(patch)
    for t in old:
        delete_token(place, t["id"])
    put_token(place, data, name="%s-%s" % (place.split("-")[-1], value))
    return data


def merge(run_id):
    cfg = config()
    rp = repo()
    r = one(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id)
    if not r:
        raise RuntimeError("run %s not found" % run_id)
    if not r.get("prIndex"):
        raise RuntimeError("run %s has no pull request" % run_id)
    blocking = [t.get("data") or {} for t in query(P["risks"], 'FROM $ WHERE $.status == "open" AND $.blocking == "true"', 20)]
    if blocking:
        raise RuntimeError("merge refused: %d blocking risk(s) open (%s)" % (len(blocking), ", ".join(b.get("riskId", "?") for b in blocking[:5])))
    owner, name, index = rp.get("owner", "hermann"), rp["repoId"], r["prIndex"]
    st, body = gitea("POST", "/repos/%s/%s/pulls/%s/merge" % (owner, name, index), {"Do": "squash", "delete_branch_after_merge": True, "merge_message_field": "%s: %s" % (r.get("specId"), r.get("title", ""))})
    if st not in (200, 204):
        raise RuntimeError("merge failed (%s): %s" % (st, str(body)[:300]))
    root = rp["localPath"]
    git(["checkout", "-q", rp.get("defaultBranch", "main")], cwd=root)
    git(["pull", "-q", "--ff-only", "origin", rp.get("defaultBranch", "main")], cwd=root)
    sha = head_sha(root)
    tag = str(r.get("specId", "spec"))
    git(["tag", "-f", tag, sha], cwd=root)
    git(["push", "-q", "-f", "origin", tag], cwd=root, check=False)
    run(["git", "branch", "-D", r.get("branch", "")], cwd=root, check=False)
    replace_token(P["runs"], "runId", run_id, {"status": "merged", "mergedSha": sha, "mergedAt": now()})
    replace_token(P["specs"], "specId", r.get("specId", ""), {"status": "merged", "mergedSha": sha, "mergedAt": now(), "runId": run_id})
    record_repo(name, {"html_url": rp.get("htmlUrl"), "clone_url": rp.get("cloneUrl"), "ssh_url": rp.get("sshUrl"), "default_branch": rp.get("defaultBranch", "main"), "owner": {"login": owner}},
                cfg, "bootstrapped", headSha=sha, lastMergedSpec=r.get("specId", ""), lastMergedAt=now())
    put_token(P["audit_req"], {"at": now(), "reason": "merge", "repoId": name, "sha": sha, "specId": r.get("specId", "")}, name="audit-req-%s" % sha[:7])
    iteration_id = "it-%s" % now().replace(":", "").replace("-", "")
    put_token(P["iterate"], {"at": now(), "iterationId": iteration_id, "reason": "merged", "specId": r.get("specId", ""), "requestedBy": "hermann"}, name=iteration_id)
    journal(LANE, "merge", "%s merged as %s (tag %s); audit requested; next iteration %s started" % (r.get("specId"), sha[:7], tag, iteration_id), runId=run_id, specId=r.get("specId", ""), sha=sha)
    return {"success": True, "mergedSha": sha, "tag": tag, "nextIteration": iteration_id}


def main(argv):
    if len(argv) < 2 or argv[0] != "merge":
        raise RuntimeError("usage: hermann-release.py merge <runId>")
    return merge(argv[1])


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
