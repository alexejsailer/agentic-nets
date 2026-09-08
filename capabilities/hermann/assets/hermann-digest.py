#!/usr/bin/env python3
"""hermann-digest: one compact, measured picture of the repository, then the twelve factor checks.

usage: hermann-digest.py digest [<sha>] [<repoId>]
Brings the local checkout to main (fast-forward), records the digest in p-hermann-repo-digest and
queues twelve factor command tokens (one per factor, filterable by `factor`) in p-hermann-factor-cmd.
Everything downstream reads the digest, never the raw tree.
"""
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

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

LANE = "t-hermann-digest-cmd"
NS = "{http://maven.apache.org/POM/4.0.0}"


def pom_summary(root):
    path = os.path.join(root, "pom.xml")
    if not os.path.exists(path):
        return {"present": "false"}
    tree = ET.parse(path)
    pom = tree.getroot()

    def text(el, tag):
        x = el.find(NS + tag)
        return (x.text or "").strip() if x is not None else ""

    parent = pom.find(NS + "parent")
    props = pom.find(NS + "properties")
    properties = {child.tag.replace(NS, ""): (child.text or "").strip() for child in (props if props is not None else [])}
    deps = []
    for d in pom.findall("%sdependencies/%sdependency" % (NS, NS)):
        deps.append({"g": text(d, "groupId"), "a": text(d, "artifactId"), "v": text(d, "version"), "scope": text(d, "scope") or "compile",
                     "optional": text(d, "optional")})
    plugins = [text(p, "artifactId") for p in pom.findall("%sbuild/%splugins/%splugin" % (NS, NS, NS))]
    return {
        "present": "true", "groupId": text(pom, "groupId"), "artifactId": text(pom, "artifactId"), "version": text(pom, "version"),
        "packaging": text(pom, "packaging") or "jar", "parent": ("%s:%s" % (text(parent, "artifactId"), text(parent, "version"))) if parent is not None else "",
        "bootVersion": text(parent, "version") if parent is not None else "", "javaVersion": properties.get("java.version", ""),
        "properties": properties, "dependencies": deps, "plugins": plugins,
        "snapshots": [d["a"] for d in deps if "SNAPSHOT" in d["v"]],
    }


def tree(root, depth=2):
    lines = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        level = 0 if rel == "." else rel.count(os.sep) + 1
        dirnames[:] = sorted(d for d in dirnames if d not in ("target", ".git", ".idea", "node_modules"))
        if level > depth:
            dirnames[:] = []
            continue
        for fn in sorted(filenames):
            lines.append(os.path.normpath(os.path.join(rel, fn)))
    return lines[:400]


def commits(root, n=10):
    rc, o, _ = run(["git", "log", "-n", str(n), "--format=%h|%ad|%s", "--date=short"], cwd=root, check=False)
    return [line for line in o.strip().splitlines() if line] if rc == 0 else []


def digest(argv):
    sha_arg = argv[1] if len(argv) > 1 and not argv[1].startswith("${") else ""
    repo_arg = argv[2] if len(argv) > 2 and not argv[2].startswith("${") else ""
    rp = repo(repo_arg) if repo_arg else repo()
    if not rp or not rp.get("localPath"):
        raise RuntimeError("no bootstrapped repository recorded in p-hermann-repo")
    root = rp["localPath"]
    if not os.path.isdir(os.path.join(root, ".git")):
        raise RuntimeError("%s is not a git checkout" % root)
    run(["git", "checkout", "-q", rp.get("defaultBranch", "main")], cwd=root, check=False)
    git(["pull", "-q", "--ff-only"], cwd=root, check=False)
    sha = head_sha(root)
    rc, remotes, _ = run(["git", "remote", "-v"], cwd=root, check=False)
    rc, branches, _ = run(["git", "branch", "-a", "--format=%(refname:short)"], cwd=root, check=False)
    res_dir = os.path.join(root, "src", "main", "resources")
    resources = {}
    for f in walk_files(res_dir, (".yml", ".yaml", ".properties", ".xml")):
        resources[os.path.relpath(f, root)] = read_text(f, 4000)
    main_java = walk_files(os.path.join(root, "src", "main", "java"), (".java",))
    test_java = walk_files(os.path.join(root, "src", "test", "java"), (".java",))
    migrations = sorted(os.path.relpath(f, root) for f in walk_files(os.path.join(res_dir, "db"), (".sql", ".xml", ".yaml", ".yml")))
    logback = [os.path.relpath(f, root) for f in walk_files(res_dir, (".xml",)) if "logback" in os.path.basename(f)]
    dockerfile = read_text(os.path.join(root, "Dockerfile"), 4000)
    compose = ""
    for cand in ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"):
        if os.path.exists(os.path.join(root, cand)):
            compose = read_text(os.path.join(root, cand), 3000)
            break
    scripts = {os.path.relpath(f, root): read_text(f, 1500) for f in walk_files(os.path.join(root, "bin"), (".sh",))}
    open_prs = []
    if os.environ.get("GITEA_TOKEN"):
        st, prs = gitea("GET", "/repos/%s/%s/pulls?state=open&limit=20" % (rp.get("owner", "hermann"), rp["repoId"]))
        if st == 200 and isinstance(prs, list):
            open_prs = [{"index": str(p.get("number")), "title": p.get("title", ""), "head": p.get("head", {}).get("ref", "")} for p in prs]
    data = {
        "at": now(), "repoId": rp["repoId"], "sha": sha, "sha7": sha[:7], "branch": rp.get("defaultBranch", "main"), "localPath": root,
        "remotes": remotes.strip().splitlines(), "branches": branches.strip().splitlines(),
        "pom": pom_summary(root), "resources": resources, "dockerfile": dockerfile, "compose": compose, "logback": logback,
        "scripts": scripts, "migrations": migrations,
        "mainJava": [os.path.relpath(f, root) for f in main_java][:200], "testJava": [os.path.relpath(f, root) for f in test_java][:100],
        "mainJavaCount": str(len(main_java)), "testJavaCount": str(len(test_java)),
        "commits": commits(root), "tree": tree(root), "openPrs": open_prs,
    }
    size = len(json.dumps(data))
    if size > 60000:
        data["resources"] = {k: v[:1200] for k, v in data["resources"].items()}
        data["tree"] = data["tree"][:150]
    for t in query(P["digest"], 'FROM $ WHERE $.sha == "%s" LIMIT 20' % sha, 20):
        delete_token(P["digest"], t["id"])
    put_token(P["digest"], data, name="digest-%s" % sha[:7])
    keep_last(P["digest"], "at", 10)
    queued = 0
    for num, key, name, _tag in FACTORS:
        tok = command_token("hermann-audit", ["factor", num, sha, rp["repoId"]], stage="factor", timeout_ms=900000,
                            factor=num, factorKey=key, sha=sha, repoId=rp["repoId"])
        put_token(P["factor_cmd"], tok, name="factor-%s-%s" % (num, sha[:7]))
        queued += 1
    journal(LANE, "digest", "digest of %s@%s: %s main / %s test classes, %d migrations, pom %s; %d factor checks queued" % (
        rp["repoId"], sha[:7], data["mainJavaCount"], data["testJavaCount"], len(migrations), data["pom"].get("bootVersion", "?"), queued), sha=sha)
    return {"success": True, "sha": sha, "queued": queued, "bytes": size}


def main(argv):
    if not argv or argv[0] != "digest":
        raise RuntimeError("usage: hermann-digest.py digest [<sha>] [<repoId>]")
    return digest(argv)


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
